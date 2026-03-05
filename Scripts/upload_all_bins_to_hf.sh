#!/usr/bin/env bash
set -euo pipefail

# Upload all .bin files from the current directory to a Hugging Face dataset.
REPO_ID="AIlabstar1/vector-datasets-prodV4"
REPO_TYPE="dataset"

shopt -s nullglob
files=( *.bin )

if [ "${#files[@]}" -eq 0 ]; then
  echo "No .bin files found in: $(pwd)"
  exit 1
fi

for file in "${files[@]}"; do
  echo "Uploading: $file"
  uvx hf upload "$REPO_ID" "$file" "$file" --repo-type "$REPO_TYPE"
done

echo "Done. Uploaded ${#files[@]} .bin file(s) to $REPO_ID."
