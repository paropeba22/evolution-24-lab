# S12 Evolution immutable remote build preparation

Status: **PREPARED LOCALLY; NOT PUSHED; NOT DISPATCHED; NOT BUILT**.
This ops branch does not change the approved candidate branch or its source.
No local test, build, compilation, dependency installation, DB, Docker command,
service or production action was run in preparing these files.

## Fixed input and controls

- Candidate input: `a2ad9338c5901f10d001495ba357938915d28c79`.
- Ops branch: `ops/s12-evolution-immutable-build-a2ad933`.
- Workflow: `.github/workflows/s12-owner-cutover-immutable-build.yml`.
- Repository: `paropeba22/evolution-24-lab`.
- Platform: `linux/amd64`; runner: GitHub-hosted `ubuntu-24.04`.
- Private image package: `ghcr.io/paropeba22/nexi-evolution-s12-owner-cutover-a2ad933`.
- Tag: full candidate SHA plus Actions run ID and attempt. Use the verified
  manifest digest from the transfer receipt for subsequent access.

The workflow checks out its controls at the exact event SHA into `control/`,
and independently checks out the fixed candidate SHA into `source/`. It checks
both HEADs and a clean candidate tree before building the candidate Dockerfile
with the candidate directory as context. Ops scripts are outside that context.
The existing candidate runtime/build files are not edited. Third-party Actions
are pinned to commit hashes verified against their upstream version tags.

The job grants only `contents: read` and `packages: write`. It uses the ephemeral
GITHUB_TOKEN only in checkout/package steps, never as a build argument, secret
mount or persisted Git credential. No production, EasyPanel, database, receipt,
application or deploy credential is requested. No network or host access to
production is configured.

## Remote execution boundary

The remote job builds the unchanged approved Dockerfile, exports an OCI archive
without loading/starting the image, then copies its blobs to GHCR with digest
preservation. The approved Dockerfile's existing source-builder tests, Prisma
client generation and compilation remain part of that remote image build.
No extra service/runtime test is introduced by this workflow.

No workflow step runs `docker run`, ENTRYPOINT/CMD, `nexi-start.sh`, Prisma migrate,
the deploy helper, npm db:deploy, a database, or application code from the final
image. `umoci unpack` materializes a filesystem from image bytes without executing
the image. The approved final deploy helper remains the literal-notice/exit-78
shim. Its bytes must match the candidate's Git blob after registry readback.

The workflow has no deploy/EasyPanel/SSH step, service update, pool replacement,
migration or feature activation. Publishing a private candidate artifact does
not release any production gate.

## OCI verification and private preservation

`ops/s12-verify-build-oci.py` is prepared for execution on the remote runner.
It verifies the OCI manifest/config/layer SHA-256 values and descriptor sizes,
platform and fixed source/control labels before transfer. The OCI layout-index
digest, platform-manifest digest, config digest and tar archive hash are recorded
as distinct values. This avoids confusing an archive, index, manifest or config
identifier.

The package API must show an existing package as private before transfer; a
first-publication 404 is recorded explicitly. GHCR's documented first-publication
default is private. A post-transfer authenticated API check must confirm private
visibility, and a separate anonymous request must fail with an authentication
error. Unexpected errors stop the job. No visibility change is attempted.
See [GitHub's Container registry contract](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

The immutable manifest is read back by digest and compared with the local
manifest, config and layer identities. A second authenticated transfer downloads
that exact digest to an OCI layout, then unpacks it without execution. Full OCI
blobs remain preserved in private GHCR; the temporary tar and remote runner
filesystem are not public artifact uploads.

Final byte receipts include:

- Git/blob equality for the safe deploy helper, config/start/selector and key
  ingress/attendance runtime modules.
- Exact candidate PostgreSQL schema hash; the full expected 71 migrations plus
  lock, each compared to the pinned source manifest, with file-set equality.
- Presence and file hashes for any actual `prisma/migrations` staging tree,
  provider bundles, inherited package/wrapper/env-helper, and installed Prisma
  package versions or explicit absence. No tool is executed to obtain versions.
- Final ENTRYPOINT/CMD contract and only the allowlisted `GIT_SHA` image setting.
  An inherited b206 value will be recorded as such, without rewriting it to make
  labels agree. Service overrides are outside this new build's evidence.

Only allowlisted JSON receipts, hashes and the raw OCI manifest are uploaded as
Actions artifacts for 90 days. The complete config/environment array, rootfs,
archive, auth files, arbitrary logs, buildx raw metadata and error bodies are
excluded. The public repository must not become a public archive of the image.
Credentials for later downloading the private image are supplied separately via
the approved package-read channel; none are written in these files.

The receipts link an exact source checkout and workflow run to verified image
bytes. They are not a signed independent build attestation. BuildKit provenance
and SBOM attachments are explicitly disabled; no extra id-token/attestations
permissions are granted. Artifact review and production catalog/identity gates
remain independent.

## Dispatch procedure for the coordinator

No command below was executed. The coordinator must approve publication and the
remote build first. **Pushing this ops branch triggers the build and private GHCR
write immediately**; it is not a passive preparation step.

1. Independently review the ops HEAD and keep the candidate SHA fixed.
2. After authorization, push only
   `HEAD:refs/heads/ops/s12-evolution-immutable-build-a2ad933` to origin. This exact
   branch push is the bootstrap dispatch; it never pushes the candidate branch.
3. Inspect the run for this workflow/branch and its ops event SHA. On success,
   download the named receipts artifact and retain its Actions artifact digest
   and run URL. Read `transfer-receipt.json` for the immutable GHCR reference.
4. Access the image by that digest through an authenticated package-read channel.
   Preserve the receipts with the candidate review; do not deploy from a tag.
5. If a run fails, retain its failure state; no successful evidence or readiness
   may be inferred. Any new push/retry needs coordinator authorization.

The workflow also declares `workflow_dispatch`, but a newly added workflow on an
ops branch cannot be assumed manually dispatchable: GitHub requires its presence
on the default branch for that event. The push bootstrap avoids changing default
or candidate branches. If manual dispatch is separately registered later, use the
exact ops ref and this workflow file. See [GitHub manual workflow prerequisites](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

No operational image digest, successful build, private publication or final-image
file hash exists yet for this candidate. These will be outputs of the separately
authorized remote run, not claims made by this preparation.
