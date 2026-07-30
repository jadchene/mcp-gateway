#!/usr/bin/env pwsh
$basedir = Split-Path $MyInvocation.MyCommand.Definition -Parent
& "node.exe" "$basedir/service.js" $args
exit $LASTEXITCODE
