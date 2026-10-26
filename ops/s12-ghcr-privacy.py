"""Remote runner only: package metadata allowlist; never print token/body."""
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

phase = sys.argv[1]
if phase not in {"before", "after"}:
    raise SystemExit("Invalid privacy phase")
package = "nexi-evolution-s12-owner-cutover-a2ad933"
request = urllib.request.Request(
    "https://api.github.com/users/paropeba22/packages/container/" + package,
    headers={"Authorization": "Bearer " + os.environ["GH_TOKEN"],
             "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"},
)
try:
    with urllib.request.urlopen(request, timeout=30) as response:
        record = json.load(response)
except urllib.error.HTTPError as error:
    if phase == "before" and error.code == 404:
        result = {"phase": phase, "package": package, "status": "not_visible_before_creation",
                  "rule": "First GHCR publication defaults to private; after check is mandatory."}
    else:
        raise SystemExit("Package privacy metadata unavailable; stop (HTTP status only): " + str(error.code))
else:
    if record.get("visibility") != "private" or record.get("name") != package:
        raise SystemExit("Package identity/visibility mismatch; stop")
    result = {"phase": phase, "package": package, "visibility": "private", "status": "confirmed"}
pathlib.Path("out/package-privacy-" + phase + ".json").write_text(json.dumps(result, indent=2) + "\n")
