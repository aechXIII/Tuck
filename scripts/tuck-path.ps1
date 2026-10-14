<#
.SYNOPSIS
  Add or remove one directory on the current user's PATH environment variable.
.DESCRIPTION
  Used by Tuck's NSIS installer hooks. Kept as a standalone script so the PATH
  logic is testable and the installer script stays free of shell-escaping.
  Reads the raw registry value and retains its REG_SZ or REG_EXPAND_SZ type, so
  entries such as %USERPROFILE%\bin keep expanding after a PATH edit. Exit 0
  means an entry was added or removed; exit 10 means no ownership change.
  BeforeDir can move an existing entry without claiming ownership of it.
  The installer must write its ownership marker only after a successful add.
#>
param(
    [Parameter(Mandatory)][ValidateSet('add', 'remove')][string]$Action,
    [Parameter(Mandatory)][string]$Dir,
    [string]$BeforeDir = '',
    # allows tests to exercise the transformation without changing the user's PATH
    [AllowEmptyString()][string]$PathValue,
    # selects an HKCU subkey for isolated registry-value-kind tests
    [string]$RegistrySubKey = 'Environment'
)

$ErrorActionPreference = 'Stop'

function Normalize-PathEntry([string]$Value) {
    $entry = $Value.Trim()
    if ($entry.Length -ge 2 -and $entry.StartsWith('"') -and $entry.EndsWith('"')) {
        $entry = $entry.Substring(1, $entry.Length - 2).Trim()
    }
    return [Environment]::ExpandEnvironmentVariables($entry).TrimEnd('\', '/').ToUpperInvariant()
}

if ([string]::IsNullOrWhiteSpace($Dir) -or $Dir.Contains(';') -or $BeforeDir.Contains(';')) {
    throw 'Dir must be a non-empty PATH entry.'
}

$usingPathValue = $PSBoundParameters.ContainsKey('PathValue')
$pathKey = $null
$pathKind = $null
if ($usingPathValue) {
    $current = $PathValue
}
else {
    $pathKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($RegistrySubKey)
    $hasPath = $pathKey.GetValueNames() -contains 'Path'
    $current = [string]$pathKey.GetValue(
        'Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
    )
    if ($hasPath) {
        $pathKind = $pathKey.GetValueKind('Path')
        if ($pathKind -notin @(
                [Microsoft.Win32.RegistryValueKind]::String,
                [Microsoft.Win32.RegistryValueKind]::ExpandString
            )) {
            $pathKey.Dispose()
            throw 'The user Path registry value must be a string.'
        }
    }
}
if ($null -eq $current) { $current = '' }

$parts = [System.Collections.Generic.List[string]]::new()
foreach ($part in $current.Split(';')) {
    if ($part -ne '') { [void]$parts.Add($part) }
}
$target = Normalize-PathEntry $Dir
$matching = @(
    for ($index = 0; $index -lt $parts.Count; $index++) {
        if ((Normalize-PathEntry $parts[$index]) -eq $target) { $index }
    }
)

$reordered = $false
if ($Action -eq 'add') {
    $before = -1
    if ($BeforeDir) {
        $beforeTarget = Normalize-PathEntry $BeforeDir
        for ($index = 0; $index -lt $parts.Count; $index++) {
            if ((Normalize-PathEntry $parts[$index]) -eq $beforeTarget) {
                $before = $index
                break
            }
        }
    }
    if ($matching.Count -ne 0) {
        # the CLI must precede a retained editor folder, even if bin was added by the user
        if ($before -ge 0 -and $matching[0] -gt $before) {
            $entry = $parts[$matching[0]]
            $parts.RemoveAt($matching[0])
            $parts.Insert($before, $entry)
            $reordered = $true
        }
        $status = 'already_present'
        $exitCode = 10
    }
    else {
        if ($before -ge 0) { $parts.Insert($before, $Dir) }
        else { [void]$parts.Add($Dir) }
        $status = 'added'
        $exitCode = 0
    }
}
else {
    if ($matching.Count -eq 0) {
        $status = 'not_present'
        $exitCode = 10
    }
    else {
        # remove one trailing match so equivalent entries added by the user survive
        $parts.RemoveAt($matching[$matching.Count - 1])
        $status = 'removed'
        $exitCode = 0
    }
}

$updated = $parts -join ';'
if (-not $usingPathValue) {
    if ($exitCode -eq 0 -or $reordered) {
        $kind = if ($null -eq $pathKind) {
            [Microsoft.Win32.RegistryValueKind]::String
        }
        else {
            $pathKind
        }
        $pathKey.SetValue('Path', $updated, $kind)
    }
    $pathKey.Dispose()
}
@{ status = $status; path = $updated } | ConvertTo-Json -Compress
exit $exitCode
