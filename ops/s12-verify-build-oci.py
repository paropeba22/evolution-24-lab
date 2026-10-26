"""Remote OCI byte inspection only. Never import/execute image application code."""
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tarfile

SOURCE = "a2ad9338c5901f10d001495ba357938915d28c79"
PACKAGE = "ghcr.io/paropeba22/nexi-evolution-s12-owner-cutover-a2ad933"
OUT = pathlib.Path("out")


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def digest_stream(stream):
    digest = hashlib.sha256()
    while chunk := stream.read(1024 * 1024):
        digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def digest_file(path):
    with path.open("rb") as stream:
        return digest_stream(stream)


def save(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2) + "\n")


def git(*arguments):
    return subprocess.check_output(["git", "-C", "source", *arguments])


def load_metadata():
    return json.loads((OUT / "local-oci-metadata.json").read_text())


def archive():
    require(git("rev-parse", "HEAD").decode().strip() == SOURCE, "Source SHA mismatch")
    with tarfile.open(OUT / "image.oci.tar", "r:*") as image:
        index_bytes = image.extractfile("index.json").read()
        index = json.loads(index_bytes)
        require(len(index["manifests"]) == 1, "Expected one platform manifest without attestations")
        descriptor = index["manifests"][0]

        def blob(desc, content=False):
            value = desc["digest"]
            require(re.fullmatch(r"sha256:[0-9a-f]{64}", value), "Unexpected digest format")
            member = image.getmember("blobs/sha256/" + value.split(":")[1])
            require(member.size == desc["size"], "OCI descriptor size mismatch")
            stream = image.extractfile(member)
            require(digest_stream(stream) == value, "OCI blob digest mismatch")
            return image.extractfile(member).read() if content else None

        manifest = json.loads(blob(descriptor, True))
        require("layers" in manifest and "config" in manifest, "Expected platform manifest, not index")
        config = json.loads(blob(manifest["config"], True))
        for layer in manifest["layers"]:
            blob(layer)
        require(config["os"] == "linux" and config["architecture"] == "amd64", "Platform mismatch")
        labels = (config.get("config") or {}).get("Labels") or {}
        require(labels.get("org.opencontainers.image.revision") == SOURCE, "Revision label mismatch")
        require(labels.get("io.nexi.build.control-revision") == os.environ["GITHUB_SHA"], "Control SHA mismatch")
        require(labels.get("org.opencontainers.image.source") == "https://github.com/paropeba22/evolution-24-lab", "Source label mismatch")
        metadata = {"source_commit": SOURCE, "source_tree": git("rev-parse", "HEAD^{tree}").decode().strip(),
                    "control_commit": os.environ["GITHUB_SHA"], "platform": "linux/amd64",
                    "run_url": labels["io.nexi.build.run"], "manifest_digest": descriptor["digest"],
                    "config_digest": manifest["config"]["digest"],
                    "layer_digests": [layer["digest"] for layer in manifest["layers"]],
                    "oci_layout_index_digest": "sha256:" + hashlib.sha256(index_bytes).hexdigest(),
                    "archive_sha256": digest_file(OUT / "image.oci.tar"),
                    "archive_bytes": (OUT / "image.oci.tar").stat().st_size,
                    "dockerfile_sha256": digest_file(pathlib.Path("source/Dockerfile")),
                    "all_archive_blob_digests_verified": True}
    save("local-oci-metadata.json", metadata)
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write("manifest_digest=" + metadata["manifest_digest"] + "\n")


def registry():
    metadata = load_metadata()
    data = (OUT / "registry-manifest.json").read_bytes()
    manifest = json.loads(data)
    require("sha256:" + hashlib.sha256(data).hexdigest() == metadata["manifest_digest"], "Registry manifest bytes differ")
    require(manifest["config"]["digest"] == metadata["config_digest"], "Registry config digest differs")
    require([item["digest"] for item in manifest["layers"]] == metadata["layer_digests"], "Registry layers differ")
    save("transfer-receipt.json", {**metadata, "package": PACKAGE,
         "tag": SOURCE + "-run-" + os.environ["GITHUB_RUN_ID"] + "-" + os.environ["GITHUB_RUN_ATTEMPT"],
         "immutable_ref": PACKAGE + "@" + metadata["manifest_digest"],
         "registry_manifest_bytes_verified": True,
         "storage": "Full image blobs remain only in private GHCR; Actions artifacts contain allowlisted receipts."})


def rootfs():
    root = (OUT / "registry-unpack/rootfs").resolve()
    records = []

    def file(relative, required=True):
        path = root / relative
        require(path.resolve().is_relative_to(root), "Unexpected path escape")
        if not path.is_file():
            require(not required, "Required image file missing: " + relative)
            return None
        records.append({"path": "/" + relative, "bytes": path.stat().st_size, "sha256": digest_file(path)})
        return path

    direct = ["Docker/scripts/deploy_database.sh", "prisma.config.ts", "nexi-start.sh",
              "select-provider-bundle.cjs", "nexi-ingress-owner-generation.cjs", "nexi-ingress.cjs",
              "nexi-ingress-effects.cjs", "nexi-ingress-dispatch.cjs", "nexi-attendance.cjs",
              "nexi-attendance-authority.cjs", "nexi-attendance-dispatch.cjs"]
    for relative in direct:
        path = file("evolution/" + relative)
        require(path.read_bytes() == git("show", SOURCE + ":" + relative), "Source/image bytes differ: " + relative)
    schema = file("evolution/prisma/postgresql-schema.prisma")
    require(digest_file(schema) == "sha256:403b508bf0da6ceccb461b2b61837da1c450d8f36008acdee75f47018cc14463", "Candidate schema bytes differ")
    evidence = json.loads(git("show", SOURCE + ":ops/s12-evolution-git-evidence.json"))
    expected_paths = set()
    for migration in evidence["prisma"]["provider_migration_files"]:
        relative = "evolution/" + migration["provider_path"]
        expected_paths.add(relative)
        path = file(relative)
        require(digest_file(path) == "sha256:" + migration["git_blob_raw_sha256"], "Provider migration bytes differ: " + relative)
    actual_paths = {str(path.relative_to(root)) for path in (root / "evolution/prisma/postgresql-migrations").rglob("*") if path.is_file()}
    require(actual_paths == expected_paths, "Provider migration file set differs")
    stage = root / "evolution/prisma/migrations"
    for path in sorted(stage.rglob("*")) if stage.is_dir() else []:
        if path.is_file():
            file(str(path.relative_to(root)))
    for relative in ["dist/main.js", "dist/providers/postgresql.js", "dist/providers/psql_bouncer.js",
                     "prisma/psql_bouncer-schema.prisma", "runWithProvider.js", "package.json",
                     "Docker/scripts/env_functions.sh"]:
        file("evolution/" + relative)
    versions = []
    for name in ["prisma", "@prisma/client", "@prisma/engines", "@prisma/adapter-pg"]:
        path = file("evolution/node_modules/" + name + "/package.json", required=False)
        versions.append({"package": name, "present": path is not None,
                         "version": json.loads(path.read_text()).get("version") if path else None})
    metadata = load_metadata()
    config_path = OUT / "registry-layout/blobs/sha256" / metadata["config_digest"].split(":")[1]
    require(digest_file(config_path) == metadata["config_digest"], "Readback config bytes differ")
    config = json.loads(config_path.read_text()).get("config") or {}
    require(config.get("Entrypoint") == ["/bin/sh", "/evolution/nexi-start.sh"], "Unexpected final entrypoint")
    require(config.get("Cmd") in ([], None), "Unexpected final command")
    git_sha = [value.split("=", 1)[1] for value in config.get("Env", []) if value.startswith("GIT_SHA=")]
    require(all(re.fullmatch(r"[0-9a-f]{40}", value) for value in git_sha), "Unexpected GIT_SHA format; do not publish value")
    save("final-file-inventory.json", {"source_commit": SOURCE, "immutable_ref": PACKAGE + "@" + metadata["manifest_digest"],
         "capture": "Authenticated digest readback and umoci rootless unpack; image code never executed.", "files": records})
    save("final-image-contract.json", {"source_commit": SOURCE, "manifest_digest": metadata["manifest_digest"],
         "config_digest": metadata["config_digest"], "entrypoint": config.get("Entrypoint"), "cmd": config.get("Cmd"),
         "image_config_git_sha": git_sha, "git_sha_origin": "Immutable image config; no service override is used by this build.",
         "installed_prisma_versions": versions, "staged_migrations_directory_present": stage.is_dir(),
         "candidate_direct_copy_bytes_verified": True, "provider_migration_bytes_and_file_set_verified": True,
         "production_deployed": False, "runtime_or_migration_executed": False,
         "limits": "Build receipt and image bytes are not a signed third-party attestation or operational DB/catalog proof."})


if __name__ == "__main__":
    mode = sys.argv[1]
    require(mode in {"archive", "registry", "rootfs"}, "Invalid inspection mode")
    globals()[mode]()
