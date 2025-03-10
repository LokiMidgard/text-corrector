# $scriptPath = Split-Path -parent $MyInvocation.MyCommand.Definition

# push-location $scriptPath

cd repo

# fetch all spellchecks
# git ls-remote returns 228e8224d19740744ef603553a7dc058caffe6eb	refs/spellcheck/fd9a77b040d7b4eac93c375ca1814ba73ca61fe9
# we need the refs part only if spellcheck is part of it
git ls-remote origin | Where-Object { $_ -match 'refs/spellcheck/' } | ForEach-Object { 
    $ref = $_.Split("`t")[1]
    $oid = $_.Split("`t")[0]
    git fetch origin $ref
    git update-ref $ref  $oid
}


cd ..




# pop-location