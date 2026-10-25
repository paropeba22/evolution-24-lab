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
function ReadLf([string]$file) { [IO.File]::ReadAllText($file).Replace("`r`n","`n") }
function DeriveSchema([string]$overlay) {
  # Static evaluation of only the exact schema text transformations, not patcher
  # execution, Prisma generation, application build or schema reconstruction by
  # guessed models. Every input and transformation is retained by revision/hash.
  $source=ReadLf (Join-Path $upstreamPath 'prisma\postgresql-schema.prisma')
  $inbox='  nameInbox               String?   @db.VarChar(100)'
  if (($source.Split(@($inbox),[StringSplitOptions]::None)).Count -ne 2) { throw 'Inbox anchor mismatch' }
  $source=$source.Replace($inbox,$inbox+"`n  inboxId                 String?   @db.VarChar(32)")
  $start=$source.IndexOf('model Instance {'); $end=$source.IndexOf("`n}",$start)
  if ($start -lt 0 -or $end -le $start) { throw 'Instance anchor mismatch' }
  $source=$source.Insert($end,"`n  nexiGroupsSocketOwner String? @db.VarChar(36)`n  NexiGroupControl NexiGroupControl?`n  NexiGroupEventOutbox NexiGroupEventOutbox[]")
  $groupPatcher=ReadLf (Join-Path $overlay 'patch-groups-source.mjs')
  $group=[regex]::Match($groupPatcher,'(?s)return source \+ `(\n\nmodel NexiGroupControl \{.*?\n)`;\n\}\);')
  if (-not $group.Success) { throw 'Exact group schema template not found' }
  $source += $group.Groups[1].Value.Replace('${json}','@db.JsonB')
  $source += "`n"+(ReadLf (Join-Path $overlay 'attendance-models.prisma')).Replace('JSON_TYPE','@db.JsonB')
  $source += "`n"+(ReadLf (Join-Path $overlay 'ingress-models.prisma')).Replace('JSON_TYPE','@db.JsonB').Replace('LARGE_TEXT','@db.Text')
  return $source
}
$baseline=DeriveSchema $basePath
$candidate=DeriveSchema $candidatePath
$wrapper=[IO.File]::ReadAllText((Join-Path $upstreamPath 'runWithProvider.js'))
$variants=[ordered]@{raw=$wrapper;lf=$wrapper.Replace("`r`n","`n");lf_with_trailing_lf=$wrapper.Replace("`r`n","`n").TrimEnd("`n")+"`n";crlf=$wrapper.Replace("`r`n","`n").Replace("`n","`r`n");crlf_with_trailing_crlf=$wrapper.Replace("`r`n","`n").TrimEnd("`n").Replace("`n","`r`n")+"`r`n"}
$result=[ordered]@{
 status='STATIC_BYTE_DERIVATION_NOT_BUILT_OR_DEPLOYED'
 upstream='e273b904d53f5726970fd6a244ed9caa61dfeb9a'
 overlay_baseline='f248f1ede50ec2d5519cef0ba4c391a49d6124b4'
 overlay_candidate_source='87a82765f52ad9945f9bf52562e99c84e1ad6a49'
 baseline_lf_sha256=(Digest $baseline)
 candidate_lf_sha256=(Digest $candidate)
 reported_runtime_schema_sha256='145e9ac35677739e544c5092b7c7326d9271d9dbfebc6a5690fe014338e85d7f'
 baseline_matches_reported=((Digest $baseline) -eq '145e9ac35677739e544c5092b7c7326d9271d9dbfebc6a5690fe014338e85d7f')
 wrapper_variants=@(foreach ($name in $variants.Keys) { [ordered]@{variant=$name;sha256=(Digest $variants[$name]);matches_reported=((Digest $variants[$name]) -eq 'e0a66767b5a349b74d70584204ade30f8debfc760253070a2507574621eee1f8')} })
}
[IO.File]::WriteAllText([IO.Path]::GetFullPath($OutputPath),($result | ConvertTo-Json -Depth 6)+"`n",[Text.UTF8Encoding]::new($false))
$result | ConvertTo-Json -Depth 6
