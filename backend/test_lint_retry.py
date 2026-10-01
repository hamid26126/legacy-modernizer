from dotenv import load_dotenv
load_dotenv()

import sys
sys.stdout.reconfigure(encoding="utf-8")

from pathlib import Path
from sandbox_verify import build_base_checkpoint, write_all_files, run_full_verification, guess_broken_file
from executor import fix_file_with_build_error

OUTPUT_PATH = Path(__file__).parent.parent / "output"
migrated = {
    "index.html": (OUTPUT_PATH / "index.html").read_text(),
    "src/index.css": (OUTPUT_PATH / "src/index.css").read_text(),
    "src/App.jsx": (OUTPUT_PATH / "src/App.jsx").read_text(),
}

# Inject a lint error (not a build-breaking one): reference an undefined variable
original = migrated["src/App.jsx"]
import re as _re
match = _re.search(r"function\s+\w+\s*\([^)]*\)\s*\{", original)
if match:
    insert_at = match.end()
    injected = original[:insert_at] + "\n  console.log(thisVariableDoesNotExist);" + original[insert_at:]
else:
    print("WARNING: no function declaration found, appending injection at end of file instead.")
    injected = original + "\nconsole.log(thisVariableDoesNotExist);\n"
migrated["src/App.jsx"] = injected

print("Building base checkpoint...")
base_cp = build_base_checkpoint()

print("\n--- Attempt 1 (expected: build PASS, lint FAIL) ---")
cp = write_all_files(base_cp, migrated)
result = run_full_verification(cp)
print(f"Passed: {result['passed']} | Stage: {result['stage']}")
print("Output (tail):\n", result["output"][-1000:])

if result["passed"]:
    print("\nUnexpected: verification passed despite the injected lint error. Stopping.")
elif result["stage"] != "lint":
    print(f"\nUnexpected: failure was attributed to '{result['stage']}' stage, not 'lint'. Stopping.")
else:
    broken_file = guess_broken_file(result["output"], list(migrated.keys()))
    print(f"\nIdentified broken file: {broken_file}")
    if broken_file != "src/App.jsx":
        print("FAILURE: guess_broken_file did not correctly identify src/App.jsx from lint output.")
    else:
        notes = "React file from a jQuery migration. Fix the lint error below."
        fixed = fix_file_with_build_error("app.js", broken_file, migrated[broken_file], notes, result["output"])
        migrated[broken_file] = fixed

        print("\n--- Attempt 2 (after self-correction) ---")
        cp2 = write_all_files(base_cp, migrated)
        result2 = run_full_verification(cp2)
        print(f"Passed: {result2['passed']} | Stage: {result2['stage']}")
        if result2["passed"]:
            print("\nLINT SELF-CORRECTION SUCCEEDED.")
        else:
            print("Output (tail):\n", result2["output"][-1000:])
