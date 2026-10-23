#Requires -Version 7.5
# banner_to_json.ps1 — build semesters/{id}/classes.json from Banner via the Ellucian Ethos API.
# Replaces the PDF parser (pdf_to_json.py) as the primary source: Banner reflects sections
# added/cancelled after the registration packet was printed.
#
# Run in YOUR OWN terminal — the API key must never land in a chat transcript or a commit:
#
#   pwsh tools/banner_to_json.ps1 -Semester spring-2027            # pull (cached) + convert
#   pwsh tools/banner_to_json.ps1 -Semester spring-2027 -Refresh   # re-pull everything
#   pwsh tools/banner_to_json.ps1 -Semester spring-2027 -Offline   # convert from cache only
#
# Key: $env:ETHOS_API_KEY, or the only line of %USERPROFILE%\.ethos-key (same key/convention
# as the loadsheets repo). Raw pulls are cached in tools/banner-cache/{semester}/ (gitignored).
# A first pull takes ~5-10 min: instructional-events only accepts a per-section filter.
#
# If semesters/{id}/config.json doesn't exist, a DRAFT is written with dates derived from
# Banner. The exam grid and most holidays are NOT in Banner — finish it by hand (CLAUDE.md).

param(
    [Parameter(Mandatory)][string]$Semester,   # e.g. spring-2027, fall-2026
    [string]$TermCode,                         # Banner term code; derived for fall/spring
    [string]$CacheDir,
    [string]$Output,
    [switch]$Refresh,
    [switch]$Offline
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent

if ($Semester -notmatch '^(?<season>[a-z]+)-(?<year>\d{4})$') { throw "Semester must look like spring-2027 (got '$Semester')." }
$season = $Matches.season; $year = [int]$Matches.year
if (-not $TermCode) {
    # Wheaton term codes: YYYY01 = spring, YYYY08 = fall. Pass -TermCode for anything else.
    $TermCode = switch ($season) { 'spring' { "${year}01" } 'fall' { "${year}08" } default { throw "Pass -TermCode for '$season' terms." } }
}
if (-not $CacheDir) { $CacheDir = Join-Path $PSScriptRoot "banner-cache/$Semester" }
if (-not $Output)   { $Output   = Join-Path $Root "semesters/$Semester/classes.json" }

# --- Ethos client -------------------------------------------------------------------------

$EthosBase = 'https://integrate.elluciancloud.com'
$script:Token = $null
$script:LastCall = Get-Date '2000-01-01'

function Get-ApiKey {
    if ($env:ETHOS_API_KEY) { return $env:ETHOS_API_KEY }
    $f = Join-Path $HOME '.ethos-key'
    if (Test-Path $f) { return (Get-Content $f -Raw).Trim() }
    throw "No API key. Set `$env:ETHOS_API_KEY for this session, or save the key as the only line of $f."
}

function Update-Token {
    $r = Invoke-WebRequest -Method Post -Uri "$EthosBase/auth" -SkipHttpErrorCheck `
        -Headers @{ Authorization = "Bearer $(Get-ApiKey)" }
    if ($r.StatusCode -ne 200) { throw "Ethos /auth failed: HTTP $($r.StatusCode)" }
    $script:Token = ([string]$r.Content).Trim()
}

function Invoke-Ethos {
    # GET with ~4 req/s throttle, re-auth on 401 (tokens live ~5 min), backoff on 429/5xx.
    # Returns $null on 403/404 when -Optional, so ungranted resources degrade instead of abort.
    param([Parameter(Mandatory)][string]$Path, [switch]$Optional, [int]$MaxRetries = 5)
    if (-not $script:Token) { Update-Token }
    for ($try = 0; $try -le $MaxRetries; $try++) {
        $since = ((Get-Date) - $script:LastCall).TotalMilliseconds
        if ($since -lt 250) { Start-Sleep -Milliseconds (250 - [int]$since) }
        $script:LastCall = Get-Date
        $r = Invoke-WebRequest -Uri "$EthosBase$Path" -SkipHttpErrorCheck `
            -Headers @{ Authorization = "Bearer $script:Token"; Accept = 'application/json' }
        $code = [int]$r.StatusCode
        if ($code -eq 200) { return ($r.Content | ConvertFrom-Json -Depth 30 -DateKind String) }
        if ($code -eq 401) { Update-Token; continue }
        if ($code -in 403, 404 -and $Optional) { return $null }
        if ($code -eq 429 -or $code -ge 500) { Start-Sleep -Seconds ([math]::Pow(2, $try)); continue }
        throw "HTTP $code on $Path — $($r.Content)"
    }
    throw "Gave up after $MaxRetries retries on $Path"
}

function Get-EthosAll {
    # Paged fetch. Stops on a short page — X-Total-Count is unreliable on this tenant.
    param([Parameter(Mandatory)][string]$Resource, [string]$Criteria, [int]$PageSize = 100, [switch]$Optional)
    $all = [System.Collections.Generic.List[object]]::new()
    for ($offset = 0; ; $offset += $PageSize) {
        $qs = "limit=$PageSize&offset=$offset"
        if ($Criteria) { $qs += "&criteria=$([uri]::EscapeDataString($Criteria))" }
        $page = Invoke-Ethos "/api/$Resource`?$qs" -Optional:$Optional
        if ($null -eq $page) { return $null }
        $page = @($page)
        foreach ($row in $page) { $all.Add($row) }
        if ($page.Count -lt $PageSize) { break }
    }
    return , $all.ToArray()
}

# --- Cache --------------------------------------------------------------------------------

function Read-Cache([string]$Name) {
    $f = Join-Path $CacheDir "$Name.json"
    if (-not (Test-Path $f)) { return $null }
    Get-Content $f -Raw | ConvertFrom-Json -Depth 30 -DateKind String
}

function Step([string]$Name, [scriptblock]$Pull) {
    # Pull once and cache; later runs reuse the cache unless -Refresh.
    $f = Join-Path $CacheDir "$Name.json"
    if ((Test-Path $f) -and -not $Refresh) { Write-Host "[$Name] cached" -ForegroundColor DarkGray; return }
    if ($Offline) { throw "[$Name] not cached and -Offline was given." }
    Write-Host "[$Name] pulling..." -ForegroundColor Cyan
    $data = & $Pull
    if ($null -eq $data) { $data = @() }
    New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
    ConvertTo-Json -InputObject @($data) -Depth 30 | Set-Content -Path $f -Encoding utf8
}

# --- Pull ---------------------------------------------------------------------------------

Step 'period' {
    $p = @(Get-EthosAll -Resource 'academic-periods' -Criteria ('{"code":"' + $TermCode + '"}'))
    if (-not $p) { $p = @(Get-EthosAll -Resource 'academic-periods' -PageSize 200 | Where-Object code -eq $TermCode) }
    if (-not $p) { throw "No academic period with code $TermCode." }
    $p
}
$period = @(Read-Cache 'period')[0]

# Filter by reportingAcademicPeriod (the parent term): quad sections attach to sub-term
# periods, so filtering on academicPeriod would miss them.
Step 'sections' {
    Get-EthosAll -Resource 'sections' -Criteria ('{"reportingAcademicPeriod":{"id":"' + $period.id + '"}}')
}
$sections = @(Read-Cache 'sections')
Write-Host ("{0} ({1}): {2} sections in Banner" -f $period.title, $TermCode, $sections.Count)

Step 'subjects' { Get-EthosAll -Resource 'subjects' -PageSize 200 }

Step 'courses' {
    $ids = @($sections | ForEach-Object { $_.course.id } | Where-Object { $_ } | Select-Object -Unique)
    $i = 0
    foreach ($id in $ids) {
        if (++$i % 100 -eq 0) { Write-Host "  courses: $i / $($ids.Count)" }
        Invoke-Ethos "/api/courses/$id"
    }
}

# Banner course attributes (the SHAR/COMP/... tags). Optional: if the key isn't granted
# course-categories, attributes still map through tools/banner-attributes.json.
Step 'categories' { Get-EthosAll -Resource 'course-categories' -PageSize 200 -Optional }

# Meeting days/times. instructional-events rejects an academicPeriod filter (HTTP 400),
# so it's one query per section.
Step 'events' {
    $i = 0
    foreach ($s in $sections) {
        if (++$i % 100 -eq 0) { Write-Host "  events: $i / $($sections.Count) sections" }
        $crit = [uri]::EscapeDataString('{"section":{"id":"' + $s.id + '"}}')
        foreach ($e in @(Invoke-Ethos "/api/instructional-events?limit=50&criteria=$crit")) {
            [pscustomobject]@{ section = $s.id; recurrence = $e.recurrence }
        }
    }
}

# --- Convert ------------------------------------------------------------------------------

$courses = @{}; foreach ($c in Read-Cache 'courses') { $courses[$c.id] = $c }
$subjects = @{}; foreach ($s in Read-Cache 'subjects') { $subjects[$s.id] = $s.abbreviation }
$categories = @{}; foreach ($c in @(Read-Cache 'categories')) { if ($c) { $categories[$c.id] = $c } }
$eventsBySection = @{}
foreach ($e in Read-Cache 'events') {
    $sid = if ($e.section.id) { $e.section.id } else { $e.section }
    $eventsBySection[$sid] += , $e
}

# Banner category GUID -> packet tag. GUIDs are stable across terms. Several Banner
# attributes collapse into one packet tag (e.g. four separate GUIDs all print as COMP).
$attrMapFile = Join-Path $PSScriptRoot 'banner-attributes.json'
$attrMap = @{}
if (Test-Path $attrMapFile) {
    (Get-Content $attrMapFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $attrMap[$_.Name] = $_.Value }
}
$knownTags = [System.Collections.Generic.HashSet[string]]::new([string[]]@($attrMap.Values))
$unmappedCats = @{}

# Full-term window = the most common section date range. Banner's endOn is the last day of
# FINALS week, not the last class day (Fall 2026: sections end 12-17, classes end 12-11).
$fullRange = $sections | Group-Object { "$($_.startOn)|$($_.endOn)" } | Sort-Object Count -Descending | Select-Object -First 1
$termStart, $termEnd = $fullRange.Name.Split('|') | ForEach-Object { [datetime]::ParseExact($_, 'yyyy-MM-dd', $null) }

function Get-Quad($s) {
    # A = starts with the term, ends well before it; B = the mirror; anything else (full
    # term, or odd windows like a fall-break trip) is "1", which the app treats as FULL.
    $start = [datetime]::ParseExact($s.startOn, 'yyyy-MM-dd', $null)
    $end   = [datetime]::ParseExact($s.endOn,   'yyyy-MM-dd', $null)
    $startsWithTerm = $start -le $termStart.AddDays(7)
    $endsWithTerm   = $end -ge $termEnd.AddDays(-7)
    if ($startsWithTerm -and -not $endsWithTerm) { return 'A' }
    if ($endsWithTerm -and -not $startsWithTerm) { return 'B' }
    return '1'
}

function Format-Credits($s, $course) {
    # Packet format: "4", "0.5", "2 TO 4" (range), "2 OR 4" (increment = only the endpoints).
    $cr = @($s.credits)[0]
    if (-not $cr) { $cr = @($course.credits)[0] }
    if (-not $cr -or $null -eq $cr.minimum) { return '' }
    if ($null -eq $cr.maximum -or $cr.maximum -eq $cr.minimum) { return [string]$cr.minimum }
    $sep = if ($cr.increment) { 'OR' } else { 'TO' }
    return "$($cr.minimum) $sep $($cr.maximum)"
}

$DayLetter = @{ monday = 'M'; tuesday = 'T'; wednesday = 'W'; thursday = 'R'; friday = 'F'; saturday = 'S'; sunday = 'U' }
$DayOrder = 'MTWRFSU'

function Get-Meetings($sectionId) {
    $out = [System.Collections.Generic.List[object]]::new()
    $seen = @{}
    foreach ($e in @($eventsBySection[$sectionId])) {
        if (-not $e) { continue }
        $days = @($e.recurrence.repeatRule.daysOfWeek | Where-Object { $_ } | ForEach-Object { $DayLetter[$_] } | Where-Object { $_ } |
            Sort-Object { $DayOrder.IndexOf($_) })
        # Banner's trailing Z is decorative: 09:20Z means 9:20 AM wall-clock. Never TZ-convert.
        $start = if ($e.recurrence.timePeriod.startOn -match 'T(\d\d:\d\d)') { $Matches[1] }
        $end   = if ($e.recurrence.timePeriod.endOn   -match 'T(\d\d:\d\d)') { $Matches[1] }
        if (-not $days -or -not $start -or -not $end -or $start -eq $end) { continue }
        $key = "$($days -join '')|$start|$end"
        if ($seen[$key]) { continue }
        $seen[$key] = $true
        $out.Add([ordered]@{ days = $days; start = $start; end = $end })
    }
    return , @($out | Sort-Object { $DayOrder.IndexOf($_.days[0]) }, { $_.start })
}

$classes = foreach ($s in $sections) {
    # Skip cancelled/closed sections and ones hidden from the catalog (dissertation hours,
    # CSA/ICP placeholder sections, ...) — those never appeared in the packet either.
    if ($s.status.category -notin 'open', 'pending') { continue }
    if ($s.catalogDisplay -eq 'hidden') { continue }

    $course = $courses[$s.course.id]
    if (-not $course) { Write-Warning "Section $($s.code): course $($s.course.id) not cached"; continue }
    # The packet prints multi-word subjects without the space ("B EC" -> "BEC").
    $subj = ($subjects[$course.subject.id] ?? '') -replace '\s', ''
    $num = $course.number
    $sec = $s.number
    $crn = $s.code
    $title = (@($s.titles) + @($course.titles) | Where-Object { $_.value } | Select-Object -First 1).value

    $attrs = [System.Collections.Generic.List[string]]::new()
    foreach ($g in @($s.courseCategories.id)) {
        if (-not $g) { continue }
        $tag = $attrMap[$g]
        if (-not $tag -and $categories[$g] -and $knownTags.Contains([string]$categories[$g].code)) { $tag = $categories[$g].code }
        if ($tag) { if (-not $attrs.Contains($tag)) { $attrs.Add($tag) } }
        else { $unmappedCats[$g] = 1 + [int]$unmappedCats[$g] }
    }

    $meetings = Get-Meetings $s.id
    [ordered]@{
        id         = "$subj-$num-$sec-$crn"
        crn        = $crn
        code       = "$subj $num"
        department = $subj
        attributes = @($attrs)
        section    = $sec
        quad       = Get-Quad $s
        xl         = ''
        title      = $title
        credits    = Format-Credits $s $course
        meetings   = $meetings
        notes      = if ($meetings.Count) { '' } else { 'TBA' }
    }
}
$classes = @($classes | Sort-Object { $_.department }, { $_.code }, { $_.section }, { $_.crn })

New-Item -ItemType Directory -Force -Path (Split-Path $Output) | Out-Null
ConvertTo-Json -InputObject $classes -Depth 10 | Set-Content -Path $Output -Encoding utf8NoBOM
$tba = @($classes | Where-Object { -not $_.meetings.Count }).Count
Write-Host ("Wrote {0} classes ({1} TBA) to {2}" -f $classes.Count, $tba, $Output) -ForegroundColor Green

if ($unmappedCats.Count) {
    # Mostly non-tag categories (levels, course types) — but a new gen-ed attribute would
    # show up here too. Add real tags to tools/banner-attributes.json.
    Write-Host "`nCourse categories with no packet tag (add real tags to tools/banner-attributes.json):" -ForegroundColor Yellow
    $unmappedCats.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
        $c = $categories[$_.Key]
        $desc = if ($c) { "$($c.code)  $($c.title)" } else { '(course-categories not granted — code unknown)' }
        Write-Host ("  {0}  x{1,-4} {2}" -f $_.Key, $_.Value, $desc)
    }
}

# --- Draft config + registry (new semesters only) -----------------------------------------

$semDir = Split-Path $Output
$configFile = Join-Path $semDir 'config.json'
$label = (Get-Culture).TextInfo.ToTitleCase($season) + " $year"
if (-not (Test-Path $configFile)) {
    $quadA = $sections | Where-Object { (Get-Quad $_) -eq 'A' } | Group-Object endOn | Sort-Object Count -Descending | Select-Object -First 1
    $quadB = $sections | Where-Object { (Get-Quad $_) -eq 'B' } | Group-Object startOn | Sort-Object Count -Descending | Select-Object -First 1
    $finalsStart = $termEnd.AddDays(-(([int]$termEnd.DayOfWeek + 6) % 7))   # Monday of finals week
    $fullEnd = $finalsStart.AddDays(-3)                                       # the Friday before
    $aEnd = if ($quadA) { [datetime]::ParseExact($quadA.Name, 'yyyy-MM-dd', $null) }
    $bStart = if ($quadB) { [datetime]::ParseExact($quadB.Name, 'yyyy-MM-dd', $null) }
    # The gap between A-quad end and B-quad start is the mid-term break.
    $holidays = @()
    if ($aEnd -and $bStart) { for ($d = $aEnd.AddDays(1); $d -lt $bStart; $d = $d.AddDays(1)) { $holidays += $d.ToString('yyyy-MM-dd') } }
    $prev = Get-ChildItem (Join-Path $Root 'semesters') -Directory | ForEach-Object { Join-Path $_.FullName 'config.json' } |
        Where-Object { Test-Path $_ } | Sort-Object { (Get-Item $_).LastWriteTime } | Select-Object -Last 1
    $periodCodes = if ($prev) { (Get-Content $prev -Raw | ConvertFrom-Json).periodCodes } else { @() }
    $fmt = { param($d) $d.ToString('yyyy-MM-dd') }
    $labels = [ordered]@{}
    $i = 0; foreach ($k in 'M', 'T', 'W', 'R') { $labels[$k] = $finalsStart.AddDays($i++).ToString('ddd · MMM d', [cultureinfo]::InvariantCulture) }
    $cfg = [ordered]@{
        id = $Semester; label = $label; timezone = 'America/Chicago'
        _draft = 'Generated from Banner by tools/banner_to_json.ps1. Verify dates and add holidays (Labor Day / Thanksgiving / MLK / Good Friday ...) from the approved academic calendar PDF, transcribe examSlots from the FINAL EXAMINATION SCHEDULE, then delete this field.'
        fullStart = & $fmt $termStart; fullEnd = & $fmt $fullEnd
        aQuadStart = & $fmt $termStart; aQuadEnd = if ($aEnd) { & $fmt $aEnd } else { '' }
        bQuadStart = if ($bStart) { & $fmt $bStart } else { '' }; bQuadEnd = & $fmt $fullEnd
        finalsStart = & $fmt $finalsStart; finalsEnd = & $fmt $termEnd
        finalsDays = @('M', 'T', 'W', 'R'); finalsDayLabels = $labels
        holidays = $holidays
        periodCodes = $periodCodes
        examSlots = [ordered]@{}
    }
    ConvertTo-Json -InputObject $cfg -Depth 10 | Set-Content -Path $configFile -Encoding utf8NoBOM
    Write-Host "`nWrote DRAFT $configFile — exam grid + most holidays still need transcribing." -ForegroundColor Yellow
}

$indexFile = Join-Path $Root 'semesters/index.json'
$index = Get-Content $indexFile -Raw | ConvertFrom-Json
if (-not ($index.semesters | Where-Object id -eq $Semester)) {
    $order = $year * 10 + $(if ($season -eq 'fall') { 2 } else { 1 })
    $index.semesters = @(@($index.semesters) + [pscustomobject]@{ id = $Semester; label = $label; order = $order } |
        Sort-Object order -Descending)
    ConvertTo-Json -InputObject $index -Depth 5 | Set-Content -Path $indexFile -Encoding utf8NoBOM
    Write-Host "Registered $Semester in semesters/index.json (default is still '$($index.default)')." -ForegroundColor Yellow
}
