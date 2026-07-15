#!/bin/bash
# Iteratively unblock packages flagged by the Replit Security Policy and install them

MAX=25
for i in $(seq 1 $MAX); do
  echo ""
  echo "=== Install attempt $i ==="
  output=$(npm install --legacy-peer-deps --no-audit --prefer-offline 2>&1)
  tail_out=$(echo "$output" | tail -6)
  echo "$tail_out"

  if ! echo "$output" | grep -qE "E403|Blocked by Security Policy|EOVERRIDE"; then
    echo ""
    echo "✅ Install succeeded on attempt $i"
    exit 0
  fi

  # Extract the blocked package tarball path, e.g.: /npm/jspdf/-/jspdf-2.5.2.tgz
  blocked_line=$(echo "$output" | grep "Forbidden" | head -1)
  # Pattern: /npm/<name>/-/<name>-<version>.tgz
  pkg_path=$(echo "$blocked_line" | grep -oP '/npm/[^/]+/-/[^"]+\.tgz' | head -1)
  if [ -z "$pkg_path" ]; then
    echo "❌ Could not parse blocked package from: $blocked_line"
    exit 1
  fi

  # Extract package name (the part after /npm/ and before /-/)
  pkg_name=$(echo "$pkg_path" | sed 's|/npm/||; s|/-/.*||')
  echo "🚫 Blocked: $pkg_name"

  # Update package.json: override to latest for transitive deps,
  # update devDependencies/dependencies directly for direct deps
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const name = '$pkg_name';
    let updated = false;

    // If it's a direct dependency, update in place
    if (pkg.devDependencies && pkg.devDependencies[name]) {
      pkg.devDependencies[name] = 'latest';
      updated = true;
      console.log('Updated devDependencies.' + name + ' -> latest');
    }
    if (pkg.dependencies && pkg.dependencies[name]) {
      pkg.dependencies[name] = 'latest';
      updated = true;
      console.log('Updated dependencies.' + name + ' -> latest');
    }

    // Always add/update overrides too (catches transitive deps)
    if (!pkg.overrides) pkg.overrides = {};
    pkg.overrides[name] = 'latest';
    console.log('Set overrides.' + name + ' -> latest');

    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  "
done

echo "❌ Still failing after $MAX attempts"
exit 1
