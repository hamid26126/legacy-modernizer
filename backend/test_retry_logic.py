from dotenv import load_dotenv
load_dotenv()

import json
from pathlib import Path
from sandbox_verify import build_base_checkpoint, write_all_files, run_build, guess_broken_file
from executor import fix_file_with_build_error

# Load the currently-passing migrated files as a starting point
OUTPUT_PATH = Path(__file__).parent.parent / "output"
migrated = {
    "index.html": (OUTPUT_PATH / "index.html").read_text(),
    "src/index.css": (OUTPUT_PATH / "src/index.css").read_text(),
    "src/App.jsx": (OUTPUT_PATH / "src/App.jsx").read_text(),
}

# Deliberately reintroduce the exact bug opencode found earlier: onChange{ instead of onChange={
broken_content = migrated["src/App.jsx"].replace("onChange={", "onChange{", 1)
if broken_content == migrated["src/App.jsx"]:
    print("WARNING: couldn't find 'onChange={' to break — pick a different deliberate bug below.")
migrated["src/App.jsx"] = broken_content

print("Deliberately broke src/App.jsx. Building base checkpoint...")
base_cp = build_base_checkpoint()

print("\n--- Attempt 1 (expected to FAIL) ---")
cp = write_all_files(base_cp, migrated)
passed, output = run_build(cp)
print(f"Passed: {passed}")
print("Build output (tail):\n", output[-1000:])

if passed:
    print("\nUnexpected: build passed despite the injected bug. Stopping.")
else:
    broken_file = guess_broken_file(output, list(migrated.keys()))
    print(f"\nIdentified broken file: {broken_file}")

    notes = "React file from a jQuery migration. Fix the build error below."
    fixed = fix_file_with_build_error("app.js", broken_file, migrated[broken_file], notes, output)
    migrated[broken_file] = fixed

    print("\n--- Attempt 2 (after self-correction) ---")
    cp2 = write_all_files(base_cp, migrated)
    passed2, output2 = run_build(cp2)
    print(f"Passed: {passed2}")
    if not passed2:
        print("Build output (tail):\n", output2[-1000:])
    else:
        print("\nSELF-CORRECTION SUCCEEDED — this is your demo proof.")