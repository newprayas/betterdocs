import os
import random
import string
import json

def get_random_code():
    # Digit, Letter, Digit
    d1 = random.choice(string.digits)
    l = random.choice(string.ascii_lowercase)
    d2 = random.choice(string.digits)
    return f"{d1}{l}{d2}"

def format_bytes(num_bytes: int) -> str:
    # Human-readable file size (B, KB, MB, GB, ...)
    units = ["B", "KB", "MB", "GB", "TB", "PB"]
    size = float(num_bytes)
    unit_idx = 0
    while size >= 1024 and unit_idx < len(units) - 1:
        size /= 1024.0
        unit_idx += 1
    if unit_idx == 0:
        return f"{int(size)} {units[unit_idx]}"
    return f"{size:.1f} {units[unit_idx]}"

def main():
    files_to_process = [
        f for f in os.listdir(".")
        if f.endswith(".json.gz") and os.path.isfile(f)
    ]

    mapping = {}
    used_codes = set()

    print(f"Found {len(files_to_process)} files to process.")

    for filename in files_to_process:
        # Generate a unique code
        while True:
            code = get_random_code()
            if code not in used_codes:
                used_codes.add(code)
                break

        shard_name = f"shard_{code}"
        new_filename = f"{shard_name}.bin"

        try:
            os.rename(filename, new_filename)

            # Size of the renamed/converted file
            size_bytes = os.path.getsize(new_filename)
            size_human = format_bytes(size_bytes)

            print(f"Renamed: {filename} -> {new_filename} ({size_human})")

            # Store richer mapping info
            mapping[filename] = {
                "shard": shard_name,
                "size_bytes": size_bytes,
                "size_human": size_human
            }

        except OSError as e:
            print(f"Error renaming {filename}: {e}")

    with open("file_mapping.json", "w", encoding="utf-8") as f:
        json.dump(mapping, f, indent=4)

    print("Mapping saved to file_mapping.json")

if __name__ == "__main__":
    main()
