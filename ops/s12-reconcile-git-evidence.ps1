# Static Git object inspection only. Does not execute patchers, Prisma, SQL,
# application code, builds, tests, containers or services. No environment reads.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$UpstreamRepository,
  [string]$OverlayRepository=(Split-Path -Parent $PSScriptRoot),
  [string]$UpstreamCommit='e273b904d53f5726970fd6a244ed9caa61dfeb9a',
  [string]$BaselineCommit='f248f1ede50ec2d5519cef0ba4c391a49d6124b4',
  [Parameter(Mandatory)][string]$CandidateCommit,
  [Parameter(Mandatory)][string]$OutputPath
)
$ErrorActionPreference='Stop'
$utf8=[Text.UTF8Encoding]::new($false,$true)
function HashBytes([byte[]]$bytes) {
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}
function HashText([string]$value) { HashBytes ($utf8.GetBytes($value)) }
function GitBytes([string]$repository,[string[]]$arguments) {
  # Read stdout as bytes. Shell/native output decoding must not rewrite blobs,
  # line endings or the final newline before hashing migration content.
  $start=[Diagnostics.ProcessStartInfo]::new('git')
  $start.UseShellExecute=$false; $start.CreateNoWindow=$true
  $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
  foreach ($argument in @('-C',$repository)+$arguments) { $start.ArgumentList.Add($argument) }
  $process=[Diagnostics.Process]::Start($start)
  $errorTask=$process.StandardError.ReadToEndAsync()
  $stream=[IO.MemoryStream]::new()
  $process.StandardOutput.BaseStream.CopyTo($stream)
  $process.WaitForExit()
  $errorText=$errorTask.GetAwaiter().GetResult()
  if ($process.ExitCode -ne 0) { throw "Git inspection failed: $errorText" }
  $bytes=$stream.ToArray(); $stream.Dispose(); $process.Dispose()
  return ,$bytes
}
function GitText([string]$repository,[string[]]$arguments) {
  $utf8.GetString((GitBytes $repository $arguments))
}
function CommitRecord([string]$repository,[string]$commit) {
  if ($commit -notmatch '^[0-9a-f]{40}$') { throw 'An exact full SHA-1 commit is required' }
  $resolved=(GitText $repository @('rev-parse','--verify',"${commit}^{commit}")).Trim()
  if ($resolved -cne $commit) { throw 'Commit identity mismatch' }
  [ordered]@{commit=$resolved;tree=(GitText $repository @('rev-parse',"${commit}^{tree}")).Trim()}
}
$upstream=CommitRecord $UpstreamRepository $UpstreamCommit
$baseline=CommitRecord $OverlayRepository $BaselineCommit
$candidate=CommitRecord $OverlayRepository $CandidateCommit
$inputs=[Collections.Generic.List[object]]::new()
$snapshots=@{}
function InputText([string]$role,[string]$repository,[string]$commit,[string]$path) {
  $key=$role+'|'+$path
  if (-not $snapshots.ContainsKey($key)) {
    $blob=(GitText $repository @('rev-parse',"${commit}:$path")).Trim()
    $bytes=GitBytes $repository @('cat-file','blob',$blob)
    $header=[Text.Encoding]::ASCII.GetBytes("blob $($bytes.Length)"+[char]0)
    $sha=[Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA1)
    $sha.AppendData($header); $sha.AppendData($bytes)
    $verified=[Convert]::ToHexString($sha.GetHashAndReset()).ToLowerInvariant(); $sha.Dispose()
    if ($verified -cne $blob) { throw "Git blob integrity mismatch: $path" }
    $text=$utf8.GetString($bytes)
    $snapshots[$key]=[ordered]@{
      role=$role;commit=$commit;path=$path;git_blob=$blob;byte_length=$bytes.Length
      raw_sha256=(HashBytes $bytes);lf_text_sha256=(HashText $text.Replace("`r`n","`n"));text=$text
    }
    $record=[ordered]@{}
    foreach ($name in $snapshots[$key].Keys) { if ($name -ne 'text') { $record[$name]=$snapshots[$key][$name] } }
    $inputs.Add($record)
  }
  return $snapshots[$key].text
}
function UpstreamText([string]$path) { InputText 'upstream' $UpstreamRepository $UpstreamCommit $path }
function OverlayText([string]$role,[string]$commit,[string]$path) { InputText $role $OverlayRepository $commit $path }
function SchemaText([string]$role,[string]$commit) {
  # Evaluate only the established schema text edits, using immutable blobs.
  # Patcher blobs are recorded alongside fragments; no patcher is executed.
  $source=(UpstreamText 'prisma/postgresql-schema.prisma').Replace("`r`n","`n")
  foreach ($path in @('patch-prisma-binding.mjs','patch-groups-source.mjs','patch-attendance-source.mjs','patch-ingress-source.mjs')) {
    $null=OverlayText $role $commit $path
  }
  $inbox='  nameInbox               String?   @db.VarChar(100)'
  if ($source.Split(@($inbox),[StringSplitOptions]::None).Count -ne 2) { throw 'Inbox anchor mismatch' }
  $source=$source.Replace($inbox,$inbox+"`n  inboxId                 String?   @db.VarChar(32)")
  $start=$source.IndexOf('model Instance {'); $end=$source.IndexOf("`n}",$start)
  if ($start -lt 0 -or $end -le $start) { throw 'Instance anchor mismatch' }
  $source=$source.Insert($end,"`n  nexiGroupsSocketOwner String? @db.VarChar(36)`n  NexiGroupControl NexiGroupControl?`n  NexiGroupEventOutbox NexiGroupEventOutbox[]")
  $patcher=(OverlayText $role $commit 'patch-groups-source.mjs').Replace("`r`n","`n")
  $group=[regex]::Match($patcher,'(?s)return source \+ `(\n\nmodel NexiGroupControl \{.*?\n)`;\n\}\);')
  if (-not $group.Success) { throw 'Exact group schema template absent' }
  $source += $group.Groups[1].Value.Replace('${json}','@db.JsonB')
  $source += "`n"+(OverlayText $role $commit 'attendance-models.prisma').Replace("`r`n","`n").Replace('JSON_TYPE','@db.JsonB')
  $source += "`n"+(OverlayText $role $commit 'ingress-models.prisma').Replace("`r`n","`n").Replace('JSON_TYPE','@db.JsonB').Replace('LARGE_TEXT','@db.Text')
  return $source
}
$baselineSchema=SchemaText 'baseline_overlay' $BaselineCommit
$candidateSchema=SchemaText 'candidate_overlay' $CandidateCommit
$baselineHash=HashText $baselineSchema
$candidateHash=HashText $candidateSchema
$models=@([regex]::Matches($candidateSchema,'(?m)^model (\w+) \{') | ForEach-Object { $_.Groups[1].Value })
$contract=OverlayText 'candidate_overlay' $CandidateCommit 'ops/s12-evolution-runtime-contract.json' | ConvertFrom-Json
$contractNames=@($contract.relations | ForEach-Object { $_.name })
$missing=@($models | Where-Object { $_ -cnotin $contractNames })
$extra=@($contractNames | Where-Object { $_ -cnotin $models })
if ($missing.Count -or $extra.Count -or $models.Count -ne $contractNames.Count) { throw 'Schema/privilege model inventory mismatch' }
foreach ($path in @('Dockerfile','prisma.config.ts','nexi-start.sh','ops/s12-evolution-named-runtime-grants.sql.in','ops/s12-evolution-privileges.sql.in','ops/s12-evolution-migration-preflight.sql')) {
  $null=OverlayText 'candidate_overlay' $CandidateCommit $path
}
$wrapper=UpstreamText 'runWithProvider.js'
$package=UpstreamText 'package.json' | ConvertFrom-Json
$lock=UpstreamText 'package-lock.json' | ConvertFrom-Json -AsHashtable
$null=UpstreamText 'Docker/scripts/deploy_database.sh'
$docker=OverlayText 'candidate_overlay' $CandidateCommit 'Dockerfile'
$merged=@{}
$upstreamPaths=(GitText $UpstreamRepository @('ls-tree','-r','--name-only',$UpstreamCommit,'--','prisma/postgresql-migrations')).TrimEnd("`n").Split("`n")
foreach ($path in $upstreamPaths) {
  if ($path -notmatch '^prisma/postgresql-migrations/(?:[^/]+/migration\.sql|migration_lock\.toml)$') { throw "Unexpected provider file: $path" }
  $null=UpstreamText $path
  $merged[$path]=$snapshots['upstream|'+$path]
}
$overlayPaths=(GitText $OverlayRepository @('ls-tree','-r','--name-only',$CandidateCommit,'--','prisma/postgresql-migrations')).TrimEnd("`n").Split("`n")
foreach ($path in $overlayPaths) {
  if ($path -notmatch '^prisma/postgresql-migrations/([^/]+)/migration\.sql$') { throw "Unexpected overlay migration: $path" }
  $directory='prisma/postgresql-migrations/'+$Matches[1]
  $copy='COPY '+$directory+' /evolution/'+$directory
  if ($docker.Replace("`r`n","`n").Split("`n") -cnotcontains $copy) { throw "Dockerfile does not copy migration: $directory" }
  if ($merged.ContainsKey($path)) { throw "Upstream/overlay migration collision: $path" }
  $null=OverlayText 'candidate_overlay' $CandidateCommit $path
  $merged[$path]=$snapshots['candidate_overlay|'+$path]
}
$migrations=@(foreach ($path in ($merged.Keys | Sort-Object)) {
  $entry=$merged[$path]
  [ordered]@{
    provider_path=$path;staged_path=$path.Replace('postgresql-migrations/','migrations/')
    origin=$entry.role;commit=$entry.commit;git_blob=$entry.git_blob
    byte_length=$entry.byte_length;git_blob_raw_sha256=$entry.raw_sha256
    lf_text_sha256=$entry.lf_text_sha256;deployed_bytes_verified=$false;ledger_status='NOT_CAPTURED'
  }
})
$versions=@(foreach ($name in @('prisma','@prisma/client','@prisma/engines','@prisma/adapter-pg')) {
  $entry=$lock.packages['node_modules/'+$name]
  [ordered]@{name=$name;source_lock_version=$entry.version;source_lock_integrity=$entry.integrity;final_image_version_verified=$false}
})
$result=[ordered]@{
  status='SOURCE_GIT_BLOBS_RECONCILED_OPERATIONAL_GATES_BLOCKED';deployment_ready=$false
  source_provenance=[ordered]@{upstream=$upstream;baseline_overlay=$baseline;candidate_overlay=$candidate;git_blob_integrity_verified=$true;inputs=$inputs.ToArray()}
  schemas=[ordered]@{
    method='Static text edits from recorded immutable Git blobs; no patcher/Prisma execution or schema output file.'
    baseline_lf_sha256=$baselineHash;candidate_lf_sha256=$candidateHash
    reported_runtime_schema_sha256='145e9ac35677739e544c5092b7c7326d9271d9dbfebc6a5690fe014338e85d7f'
    baseline_matches_reported=($baselineHash -ceq '145e9ac35677739e544c5092b7c7326d9271d9dbfebc6a5690fe014338e85d7f')
    candidate_models=$models;privilege_contract_exact_model_coverage=$true
    source_attribution='Commit/tree/blob identities verified locally; not a signed build attestation or proof of final artifact content.'
  }
  prisma=[ordered]@{
    source_wrapper_raw_sha256=$snapshots['upstream|runWithProvider.js'].raw_sha256
    source_wrapper_lf_sha256=(HashText $wrapper.Replace("`r`n","`n"))
    source_package_deploy_script=$package.scripts.'db:deploy';source_versions=$versions
    final_base_scripts_and_engine_versions_verified=$false;provider_migration_files=$migrations
    checksum_boundary='raw_sha256 hashes original Git blob bytes, not Windows checkout text. Neither it nor lf_text_sha256 is a deployed ledger checksum until final artifact bytes and ledger rows are captured.'
  }
  privileges=[ordered]@{
    source_contract_commit=$CandidateCommit;source_models=$models.Count
    source_profiles=@($contract.relations.profile | Sort-Object -Unique)
    profile_selection_status='BLOCKED_DEPLOYED_CONFIGURATION_AND_CONSUMER_SCOPE_NOT_CAPTURED'
    effective_runtime_minimum_verified=$false
    sequence_dependencies=$contract.sequences
    reported_current_login='postgres';reported_current_login_is_superuser=$true
    current_runtime_satisfies_owner_generation_gate=$false
    provisioned_restricted_identity_verified=$false
    template_initial_quit_gates_remain_required=$true
  }
  operational_artifact=[ordered]@{
    status='BLOCKED_NO_VERIFIABLE_SOURCE_TO_IMAGE_BYTES_LINK'
    reported_image='ghcr.io/paropeba22/nexi-evolution-s12-dispatch-bound-f248f1e@sha256:37bec98093e3a83b20cee3eb249379e325651c8cdc68bcf775f633515e620cf0'
    reported_revision_label='f248f1ede50ec2d5519cef0ba4c391a49d6124b4';reported_git_sha='b206baaa0518ba881fade671942a693ca1c24188'
    typed_manifest_config_and_attestation_captured=$false;image_bytes_verified=$false
    note='Reported reference/label/env are observations only. Baseline schema input equality cannot distinguish b206 from f248.'
  }
  gates=[ordered]@{
    source_blob_attribution='CLOSED_FOR_RECORDED_INPUTS'
    source_schema_privilege_model_coverage='CLOSED_FOR_54_SOURCE_MODELS'
    source_provider_migration_inventory='CLOSED_FOR_PINNED_UPSTREAM_PLUS_EXPLICIT_DOCKER_COPY_INPUTS'
    operational_artifact_provenance='BLOCKED';final_migration_tree_and_full_ledger='BLOCKED'
    deployed_profiles_named_catalogs_and_sequences='BLOCKED';restricted_roles_and_fresh_maintenance_identity='BLOCKED'
  }
}
[IO.File]::WriteAllText([IO.Path]::GetFullPath($OutputPath),($result | ConvertTo-Json -Depth 14)+"`n",$utf8)
# A concise record only; raw input contents and package lock are not printed.
[ordered]@{output=$OutputPath;candidate_commit=$CandidateCommit;candidate_schema_sha256=$candidateHash;models=$models.Count;migration_sql_files=@($migrations | Where-Object { $_.provider_path.EndsWith('/migration.sql') }).Count;deployment_ready=$false} | ConvertTo-Json
