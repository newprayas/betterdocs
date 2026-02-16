import os
import random
import string
import json

def get_random_code():
    # "ltter is alway in between the 2 random digitis" -> Digit, Letter, Digit
    d1 = random.choice(string.digits)
    l = random.choice(string.ascii_lowercase)
    d2 = random.choice(string.digits)
    return f"{d1}{l}{d2}"

def main():
    # Filter for .json.gz files to rename, as per the context and example
    files_to_process = [f for f in os.listdir('.') if f.endswith('.json.gz') and os.path.isfile(f)]
    
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
        
        # New filename with .bin extension
        shard_name = f"shard_{code}"
        new_filename = f"{shard_name}.bin"
        
        # Rename the file
        try:
            os.rename(filename, new_filename)
            print(f"Renamed: {filename} -> {new_filename}")
            
            # Update mapping: "bookname.json.gz = shard_2x8"
            mapping[filename] = shard_name
        except OSError as e:
            print(f"Error renaming {filename}: {e}")
        
    # Write the mapping to a JSON file
    with open('file_mapping.json', 'w') as f:
        json.dump(mapping, f, indent=4)
    
    print("Mapping saved to file_mapping.json")

if __name__ == "__main__":
    main()
