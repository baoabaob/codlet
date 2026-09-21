[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$CodletExecutable,[Parameter(Mandatory=$true)][string]$PythonExecutable,[Parameter(Mandatory=$true)][string]$ArtifactsDirectory)
$ErrorActionPreference='Stop'
$artifacts=[IO.Path]::GetFullPath($ArtifactsDirectory)
if(Test-Path -LiteralPath $artifacts){throw 'Use a new skill CLI fixture directory'}
$scripts=Join-Path $artifacts 'skill/scripts'
$scope=Join-Path $artifacts 'portable-scope'
$sentinel=Join-Path $artifacts 'unrelated-scope'
[IO.Directory]::CreateDirectory($scripts)|Out-Null
[IO.Directory]::CreateDirectory($scope)|Out-Null
$registry=Join-Path $scope 'config.json'
[IO.File]::WriteAllText($registry,'{"schema":2,"plugins":{},"localPlugins":{}}')
$metadata=@{registry=$registry;cliExecutable=[IO.Path]::GetFullPath($CodletExecutable);cliPrefix=@();cliLocalAppData=$null}
[IO.File]::WriteAllText((Join-Path $artifacts 'skill/runtime.json'),($metadata|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
$source=Join-Path $PSScriptRoot '../runtime/skills/codlet/scripts'
foreach($name in @('codlet-cli.ps1','codlet-cli.py')){Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $scripts $name)}
$env:CODLET_HOME=$sentinel
$psText=& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts 'codlet-cli.ps1') plugin list --json
if($LASTEXITCODE -ne 0){throw 'PowerShell scoped wrapper failed'}
$psReply=($psText|Out-String)|ConvertFrom-Json
if($psReply.registry -ne $registry){throw 'PowerShell wrapper selected the inherited unrelated scope'}
$pythonText=& $PythonExecutable -X utf8 (Join-Path $scripts 'codlet-cli.py') plugin list --json
if($LASTEXITCODE -ne 0){throw 'Python scoped wrapper failed'}
$pythonReply=($pythonText|Out-String)|ConvertFrom-Json
if($pythonReply.registry -ne $registry){throw 'Python wrapper selected the inherited unrelated scope'}
if(Test-Path -LiteralPath $sentinel){throw 'Scoped CLI created an unrelated data directory'}
[pscustomobject]@{passed=$true;powershellScope=$psReply.registry;pythonScope=$pythonReply.registry;unrelatedScopeCreated=$false}|ConvertTo-Json -Compress
