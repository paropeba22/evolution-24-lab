[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$UpstreamRoot,
  [Parameter(Mandatory)][string]$BaselineOverlayRoot,
  [string]$CandidateOverlayRoot=(Split-Path -Parent $PSScriptRoot),
  [Parameter(Mandatory)][string]$OutputPath
)
$ErrorActionPreference='Stop'
function Digest([string]$text) { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($text))).ToLowerInvariant() }
$basePath=(Resolve-Path -LiteralPath $BaselineOverlayRoot).Path
$candidatePath=(Resolve-Path -LiteralPath $CandidateOverlayRoot).Path
$upstreamPath=(Resolve-Path -LiteralPath $UpstreamRoot).Path
$inputTexts=@{}
$observedInputs=[Collections.Generic.List[object]]::new()
function ReadInput([string]$role,[string]$root,[string]$relativePath) {
  $file=Join-Path $root $relativePath
  $key=$role+'|'+$file
  if (-not $inputTexts.ContainsKey($key)) {
    # Hash and consume the same in-memory decoded text snapshot. These hashes
    # describe observed content only; no Git revision is inferred from a path.
    $text=[IO.File]::ReadAllText($file)
    $inputTexts[$key]=$text
    $observedInputs.Add([ordered]@{
      role=$role;root=$root;path=$relativePath
      decoded_text_sha256=(Digest $text)
      lf_text_sha256=(Digest $text.Replace("`r`n","`n"))
    })
  }
  return $inputTexts[$key]
}
function ReadLf([string]$role,[string]$root,[string]$relativePath) { (ReadInput $role $root $relativePath).Replace("`r`n","`n") }
function DeriveSchema([string]$role,[string]$overlay) {
  # Static evaluation of only the exact schema text transformations, not patcher
  # execution, Prisma generation, application build or schema reconstruction by
  # guessed models. Consumed input text is hashed, without revision attribution.
  $source=ReadLf 'upstream' $upstreamPath 'prisma\postgresql-schema.prisma'
  $inbox='  nameInbox               String?   @db.VarChar(100)'
  if (($source.Split(@($inbox),[StringSplitOptions]::None)).Count -ne 2) { throw 'Inbox anchor mismatch' }
  $source=$source.Replace($inbox,$inbox+"`n  inboxId                 String?   @db.VarChar(32)")
  $start=$source.IndexOf('model Instance {'); $end=$source.IndexOf("`n}",$start)
  if ($start -lt 0 -or $end -le $start) { throw 'Instance anchor mismatch' }
  $source=$source.Insert($end,"`n  nexiGroupsSocketOwner String? @db.VarChar(36)`n  NexiGroupControl NexiGroupControl?`n  NexiGroupEventOutbox NexiGroupEventOutbox[]")
  $groupPatcher=ReadLf $role $overlay 'patch-groups-source.mjs'
  $group=[regex]::Match($groupPatcher,'(?s)return source \+ `(\n\nmodel NexiGroupControl \{.*?\n)`;\n\}\);')
  if (-not $group.Success) { throw 'Exact group schema template not found' }
  $source += $group.Groups[1].Value.Replace('${json}','@db.JsonB')
  $source += "`n"+(ReadLf $role $overlay 'attendance-models.prisma').Replace('JSON_TYPE','@db.JsonB')
  $source += "`n"+(ReadLf $role $overlay 'ingress-models.prisma').Replace('JSON_TYPE','@db.JsonB').Replace('LARGE_TEXT','@db.Text')
  return $source
}
$baseline=DeriveSchema 'baseline_overlay' $basePath
$candidate=DeriveSchema 'candidate_overlay' $candidatePath
$wrapper=ReadInput 'upstream' $upstreamPath 'runWithProvider.js'
$variants=[ordered]@{raw=$wrapper;lf=$wrapper.Replace("`r`n","`n");lf_with_trailing_lf=$wrapper.Replace("`r`n","`n").TrimEnd("`n")+"`n";crlf=$wrapper.Replace("`r`n","`n").Replace("`n","`r`n");crlf_with_trailing_crlf=$wrapper.Replace("`r`n","`n").TrimEnd("`n").Replace("`n","`r`n")+"`r`n"}
$result=[ordered]@{
 status='STATIC_BYTE_DERIVATION_NOT_BUILT_OR_DEPLOYED'
 input_provenance=[ordered]@{
   status='OBSERVED_CONTENT_ONLY'
   revision_attribution_verified=$false
   hash_scope='SHA-256 of UTF-8 re-encoded decoded text; ReadAllText strips encoding BOM; LF hash normalizes CRLF only.'
   inputs=$observedInputs.ToArray()
   limits='No Git commit/blob validation, full patcher equivalence, build or deployed artifact provenance is established. A matching output hash does not identify a source revision.'
 }
 baseline_lf_sha256=(Digest $baseline)
 candidate_lf_sha256=(Digest $candidate)
 reported_runtime_schema_sha256='145e9ac35677739e544c5092b7c7326d9271d9dbfebc6a5690fe014338e85d7f'
 baseline_matches_reported=((Digest $baseline) -eq '145e9ac35677739e544c5092b7c7326d9271d9dbfebc6a5690fe014338e85d7f')
 wrapper_variants=@(foreach ($name in $variants.Keys) { [ordered]@{variant=$name;sha256=(Digest $variants[$name]);matches_reported=((Digest $variants[$name]) -eq 'e0a66767b5a349b74d70584204ade30f8debfc760253070a2507574621eee1f8')} })
}
[IO.File]::WriteAllText([IO.Path]::GetFullPath($OutputPath),($result | ConvertTo-Json -Depth 6)+"`n",[Text.UTF8Encoding]::new($false))
$result | ConvertTo-Json -Depth 6
