# Pilotage clavier de Zed — lot C, spec §6.2 (backend `uia`, repli SendKeys).
#
# Constat de la machine cible : l'arbre UI Automation de la fenêtre Zed est
# **vide** (0 descendant). Zed dessine lui-même son interface (GPUI) et n'expose
# rien à UIA : le risque 🟠3 est avéré, et le repli clavier devient la voie.
#
# Entrée : un objet JSON sur stdin.
#   { "op": "probe" }                         fenêtres Zed + taille de l'arbre UIA
#   { "op": "run", "steps": [...], "window": "zra", "stepDelayMs": 120, "dryRun": false }
#   { "op": "run", "steps": [...], "project": "zra", … }   fenêtre du projet « zra »
#
# Étapes :
#   { "keys": "ctrl+shift+p" }   accord de touches ('+' entre les touches)
#   { "text": "..." }            saisie Unicode caractère par caractère ; "\n" => shift+enter
#   { "wait": 300 }              pause, en millisecondes
#
# Sortie : une ligne JSON { ok, error?, window?, log[] }.
#
# Garde-fous :
#   · le texte est saisi en Unicode (KEYEVENTF_UNICODE) : pas de presse-papiers
#     écrasé, pas de dépendance à la disposition du clavier (AZERTY compris) ;
#   · **avant chaque étape**, la fenêtre au premier plan doit être la fenêtre Zed
#     visée. Si l'utilisateur a cliqué ailleurs, on s'arrête net : jamais une
#     frappe envoyée dans une autre application ;
#   · `dryRun` résout tout (fenêtre, touches) sans rien envoyer.

$ErrorActionPreference = 'Stop'
# Le texte à saisir arrive en UTF-8 depuis Node, et la réponse y repart.
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class ZraKeyboard {
  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public INPUTUNION u; }

  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern short VkKeyScanW(char c);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);

  public static string Title(IntPtr h) {
    var sb = new StringBuilder(512);
    GetWindowTextW(h, sb, sb.Capacity);
    return sb.ToString();
  }

  public static uint Pid(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }

  /** Fenêtres visibles et titrées des processus donnés, dans l'ordre Z (la plus récente d'abord). */
  public static List<IntPtr> Windows(uint[] pids) {
    var set = new HashSet<uint>(pids);
    var found = new List<IntPtr>();
    EnumWindows((h, l) => {
      if (IsWindowVisible(h) && set.Contains(Pid(h)) && Title(h).Length > 0) found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }

  static INPUT Key(ushort vk, ushort scan, uint flags) {
    var i = new INPUT { type = INPUT_KEYBOARD };
    i.u.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags };
    return i;
  }

  static void Send(List<INPUT> list) {
    if (list.Count == 0) return;
    var arr = list.ToArray();
    uint sent = SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
    if (sent != arr.Length) throw new Exception("SendInput refusé (" + Marshal.GetLastWin32Error() + ")");
  }

  /** Accord : modificateurs enfoncés, touche, relâchement dans l'ordre inverse. */
  public static void Chord(ushort[] vks) {
    var list = new List<INPUT>();
    foreach (var vk in vks) list.Add(Key(vk, 0, 0));
    for (int i = vks.Length - 1; i >= 0; i--) list.Add(Key(vks[i], 0, KEYEVENTF_KEYUP));
    Send(list);
  }

  public static void Unicode(string text) {
    var list = new List<INPUT>();
    foreach (char c in text) {
      list.Add(Key(0, c, KEYEVENTF_UNICODE));
      list.Add(Key(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
    }
    Send(list);
  }

  /** Tapoter Alt débloque SetForegroundWindow depuis un processus d'arrière-plan. */
  public static void TapAlt() { Chord(new ushort[] { 0x12 }); }
}
'@

$named = @{
  'ctrl' = 0x11; 'control' = 0x11; 'shift' = 0x10; 'alt' = 0x12; 'win' = 0x5B; 'super' = 0x5B
  'enter' = 0x0D; 'return' = 0x0D; 'escape' = 0x1B; 'esc' = 0x1B; 'tab' = 0x09; 'space' = 0x20
  'backspace' = 0x08; 'delete' = 0x2E; 'insert' = 0x2D; 'home' = 0x24; 'end' = 0x23
  'pageup' = 0x21; 'pagedown' = 0x22; 'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27
}
for ($i = 1; $i -le 12; $i++) { $named["f$i"] = 0x6F + $i }

function Resolve-Chord([string]$spec) {
  $vks = New-Object System.Collections.Generic.List[uint16]
  foreach ($part in ($spec.ToLowerInvariant() -split '\+')) {
    if ($part -eq '') { throw "accord mal formé : « $spec »" }
    if ($named.ContainsKey($part)) { $vks.Add([uint16]$named[$part]); continue }
    if ($part.Length -eq 1) {
      $c = $part[0]
      if ($c -match '[a-z0-9]') { $vks.Add([uint16][char]$c.ToString().ToUpperInvariant()); continue }
      # Ponctuation : la touche dépend de la disposition du clavier.
      $scan = [ZraKeyboard]::VkKeyScanW($c)
      if ($scan -eq -1) { throw "touche introuvable sur ce clavier : « $part »" }
      $mods = ($scan -shr 8) -band 0xFF
      if ($mods -band 1) { $vks.Add(0x10) }
      if ($mods -band 2) { $vks.Add(0x11) }
      if ($mods -band 4) { $vks.Add(0x12) }
      $vks.Add([uint16]($scan -band 0xFF))
      continue
    }
    throw "touche inconnue : « $part »"
  }
  return , $vks.ToArray()
}

# `project` : la fenêtre d'un projet précis. Zed la titre « <projet> — <fichier> »
# (ou « <projet> » seul) : on compare le début du titre, pas une sous-chaîne —
# « zra » ne doit pas désigner la fenêtre de « zra-docs ».
function Test-ProjectTitle([string]$title, [string]$project) {
  $t = $title.ToLowerInvariant()
  $p = $project.ToLowerInvariant()
  return $t -eq $p -or $t.StartsWith("$p ") -or $t.StartsWith("$p,")
}

function Find-ZedWindow([string]$filter, [string]$project) {
  $pids = @(Get-Process -Name 'zed' -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
  if ($pids.Count -eq 0) { return $null }
  $windows = [ZraKeyboard]::Windows($pids)
  foreach ($h in $windows) {
    $title = [ZraKeyboard]::Title($h)
    if ($project) {
      if (Test-ProjectTitle $title $project) { return @{ handle = $h; title = $title; pid = [ZraKeyboard]::Pid($h) } }
      continue
    }
    if (-not $filter -or $title.ToLowerInvariant().Contains($filter.ToLowerInvariant())) {
      return @{ handle = $h; title = $title; pid = [ZraKeyboard]::Pid($h) }
    }
  }
  return $null
}

function Assert-Foreground($win) {
  $fg = [ZraKeyboard]::GetForegroundWindow()
  if ($fg -ne $win.handle) {
    $other = [ZraKeyboard]::Title($fg)
    throw "la fenêtre Zed n'est plus au premier plan (« $other ») : arrêt, aucune frappe envoyée ailleurs"
  }
}

function Focus-Window($win) {
  if ([ZraKeyboard]::IsIconic($win.handle)) { [void][ZraKeyboard]::ShowWindow($win.handle, 9) }
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    if ([ZraKeyboard]::GetForegroundWindow() -eq $win.handle) { return }
    [ZraKeyboard]::TapAlt()
    [void][ZraKeyboard]::SetForegroundWindow($win.handle)
    Start-Sleep -Milliseconds 80
  }
  Assert-Foreground $win
}

$log = New-Object System.Collections.Generic.List[string]
$result = @{ ok = $false; log = $log }

try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -TypeDefinition $source -Language CSharp

  if ($request.op -eq 'probe') {
    $pids = @(Get-Process -Name 'zed' -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
    $list = @()
    if ($pids.Count -gt 0) {
      Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
      foreach ($h in [ZraKeyboard]::Windows($pids)) {
        $count = -1
        try {
          $el = [System.Windows.Automation.AutomationElement]::FromHandle($h)
          $count = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition).Count
        } catch { }
        $list += @{ title = [ZraKeyboard]::Title($h); pid = [ZraKeyboard]::Pid($h); uiaDescendants = $count }
      }
    }
    $result.windows = $list
    $result.ok = $true
  }
  elseif ($request.op -eq 'run') {
    $delay = if ($request.stepDelayMs) { [int]$request.stepDelayMs } else { 120 }
    $dry = [bool]$request.dryRun

    # Tout est résolu avant la première frappe : une recette invalide ne doit
    # pas s'arrêter à mi-chemin, touches déjà envoyées.
    $plan = @()
    foreach ($step in $request.steps) {
      if ($null -ne $step.keys) { $plan += @{ kind = 'keys'; label = $step.keys; vks = (Resolve-Chord $step.keys) } }
      elseif ($null -ne $step.text) { $plan += @{ kind = 'text'; text = [string]$step.text } }
      elseif ($null -ne $step.wait) { $plan += @{ kind = 'wait'; ms = [int]$step.wait } }
      else { throw "étape inconnue : $($step | ConvertTo-Json -Compress)" }
    }

    $win = Find-ZedWindow $request.window $request.project
    # La CLI de Zed vient peut-être d'ouvrir la fenêtre du projet : on lui
    # laisse le temps d'apparaître (hors simulation, où rien n'a été lancé).
    if (-not $win -and $request.project -and $request.windowWaitMs -and -not $dry) {
      $deadline = [DateTime]::UtcNow.AddMilliseconds([int]$request.windowWaitMs)
      while (-not $win -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 250
        $win = Find-ZedWindow $request.window $request.project
      }
    }
    if (-not $win) {
      $what = if ($request.project) { "aucune fenêtre Zed pour le projet « $($request.project) »" } elseif ($request.window) { "aucune fenêtre Zed dont le titre contient « $($request.window) »" } else { 'aucune fenêtre Zed ouverte' }
      throw $what
    }
    $result.window = @{ title = $win.title; pid = $win.pid }
    $log.Add("fenêtre : $($win.title)")

    if (-not $dry) { Focus-Window $win }

    foreach ($p in $plan) {
      switch ($p.kind) {
        'wait' { $log.Add("attente $($p.ms) ms"); if (-not $dry) { Start-Sleep -Milliseconds $p.ms } }
        'keys' {
          $log.Add("touches $($p.label)")
          if (-not $dry) { Assert-Foreground $win; [ZraKeyboard]::Chord($p.vks); Start-Sleep -Milliseconds $delay }
        }
        'text' {
          $lines = $p.text -split "`r?`n"
          $log.Add("texte ($($p.text.Length) caractère(s))")
          if (-not $dry) {
            for ($i = 0; $i -lt $lines.Count; $i++) {
              Assert-Foreground $win
              if ($i -gt 0) { [ZraKeyboard]::Chord([uint16[]]@(0x10, 0x0D)) }
              if ($lines[$i].Length -gt 0) { [ZraKeyboard]::Unicode($lines[$i]) }
            }
            Start-Sleep -Milliseconds $delay
          }
        }
      }
    }
    $result.ok = $true
  }
  else {
    throw "opération inconnue : $($request.op)"
  }
}
catch {
  $result.error = $_.Exception.Message
}

[Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 5))
