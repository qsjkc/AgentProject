param(
    [switch]$Preflight,
    [int]$OwnerId,
    [string]$ExpectedExecutable,
    [double]$GrabX,
    [double]$GrabY,
    [double]$RendererScale,
    [string]$CancelPath
)

$ErrorActionPreference = 'Stop'
if (-not [Environment]::UserInteractive -or (Get-Process -Id $PID).SessionId -eq 0) {
    throw 'An interactive Windows test desktop is required.'
}
if ($Preflight) {
    if (Get-Process -Name Detachym -ErrorAction SilentlyContinue) {
        throw 'Close the running Detachym on the test desktop before testing.'
    }
    $run = Get-Item -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
    if ($run) {
        foreach ($name in $run.GetValueNames()) {
            if ($name -in @('Detachym', 'detachym-desktop', 'com.detachym.desktop') -or $run.GetValue($name) -match '(?i)(?:^|[\\/"\s])Detachym\.exe(?:"|\s|$)') {
                throw 'This account has an existing Detachym sign-in item. Use a dedicated test account.'
            }
        }
    }
    return
}
if (-not $ExpectedExecutable -or -not $CancelPath -or
    [IO.Path]::GetFileName($ExpectedExecutable) -ne 'Detachym.exe' -or
    (Get-Process -Id $OwnerId).Path -ne $ExpectedExecutable) {
    throw 'The native input helper must match the owned packaged Detachym process.'
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class DetachymNativeDrag {
    [StructLayout(LayoutKind.Sequential)] public struct Point {
        public int X, Y;
        public Point(int x, int y) { X = x; Y = y; }
    }
    [StructLayout(LayoutKind.Sequential)] public struct Rect {
        public int Left, Top, Right, Bottom;
    }
    [StructLayout(LayoutKind.Sequential)] private struct MonitorInfo {
        public int Size;
        public Rect Monitor, Work;
        public int Flags;
    }
    [StructLayout(LayoutKind.Sequential)] private struct MouseInput {
        public int X, Y;
        public uint Data, Flags, Time;
        public UIntPtr Extra;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Input {
        public uint Type;
        public MouseInput Mouse;
    }
    private delegate bool EnumerateWindow(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumerateWindow callback, IntPtr data);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint owner);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, Input[] data, int size);

    public sealed class Sample {
        public string Phase { get; set; }
        public int Trial { get; set; }
        public double ElapsedMs { get; set; }
        public Point Cursor { get; set; }
        public Rect Window { get; set; }
    }
    public sealed class Result {
        public string Error { get; set; }
        public uint Dpi { get; set; }
        public Rect Work { get; set; }
        public Point GrabOffset { get; set; }
        public double HeldMs { get; set; }
        public List<Sample> Samples { get; set; }
    }

    private static Rect Bounds(IntPtr hwnd) {
        Rect bounds;
        if (!GetWindowRect(hwnd, out bounds)) throw new InvalidOperationException("Cannot read the pet window.");
        return bounds;
    }
    private static Point Cursor() {
        Point point;
        if (!GetCursorPos(out point)) throw new InvalidOperationException("Cannot read the interactive cursor.");
        return point;
    }
    private static bool Same(Point left, Point right) { return left.X == right.X && left.Y == right.Y; }
    private static IntPtr Root(IntPtr hwnd) { return GetAncestor(hwnd, 2); }
    private static void Button(uint flags) {
        var data = new Input[] { new Input { Mouse = new MouseInput { Flags = flags } } };
        if (SendInput(1, data, Marshal.SizeOf(typeof(Input))) != 1)
            throw new InvalidOperationException("Windows did not accept native mouse input.");
    }

    public static Result Run(int ownerId, double grabX, double grabY, double rendererScale, string cancelPath) {
        var result = new Result { Samples = new List<Sample>() };
        IntPtr priorDpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
        bool held = false, cursorMoved = false;
        Point original = new Point(), commanded = new Point();
        try {
            if (priorDpi == IntPtr.Zero) throw new InvalidOperationException("Cannot sample physical DPI coordinates.");
            if (Process.GetProcessById(ownerId).SessionId != Process.GetCurrentProcess().SessionId)
                throw new InvalidOperationException("The packaged app belongs to a different Windows session.");
            if ((GetAsyncKeyState(1) & 0x8000) != 0)
                throw new InvalidOperationException("The left mouse button is already held.");
            if (GetSystemMetrics(80) != 1)
                throw new InvalidOperationException("The edge-clamp scenario requires one active test display.");

            var matches = new List<IntPtr>();
            EnumWindows(delegate(IntPtr hwnd, IntPtr data) {
                uint owner;
                GetWindowThreadProcessId(hwnd, out owner);
                if (owner != (uint)ownerId || !IsWindowVisible(hwnd)) return true;
                Rect rect;
                if (!GetWindowRect(hwnd, out rect)) return true;
                double scale = GetDpiForWindow(hwnd) / 96.0;
                if (Math.Abs(rect.Right - rect.Left - 220 * scale) <= 8 &&
                    Math.Abs(rect.Bottom - rect.Top - 240 * scale) <= 8) matches.Add(hwnd);
                return true;
            }, IntPtr.Zero);
            if (matches.Count != 1) throw new InvalidOperationException("Expected exactly one owned, visible pet HWND.");
            IntPtr pet = matches[0];
            result.Dpi = GetDpiForWindow(pet);
            double petScale = result.Dpi / 96.0;
            if (result.Dpi == 0 || result.Dpi % 96 == 0 || Math.Abs(rendererScale - petScale) > .02)
                throw new InvalidOperationException("Use an active fractional-DPI display matching the renderer (for example 150%).");
            var monitor = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
            if (!GetMonitorInfo(MonitorFromWindow(pet, 2), ref monitor)) throw new InvalidOperationException("Cannot read the pet's display work area.");
            Rect work = monitor.Work;
            int width = work.Right - work.Left, height = work.Bottom - work.Top;
            if (width < 480 * petScale || height < 480 * petScale)
                throw new InvalidOperationException("The test work area is too small for the full drag path.");
            result.Work = work;
            result.GrabOffset = new Point((int)Math.Round(grabX * petScale), (int)Math.Round(grabY * petScale));
            original = Cursor();

            var clock = Stopwatch.StartNew();
            Action check = delegate {
                uint owner;
                GetWindowThreadProcessId(pet, out owner);
                if (File.Exists(cancelPath)) throw new OperationCanceledException("Canceled by the caller.");
                if (owner != (uint)ownerId || !IsWindowVisible(pet) || Root(GetForegroundWindow()) != pet)
                    throw new InvalidOperationException("The owned pet is no longer the focused window.");
                if (GetDpiForWindow(pet) != result.Dpi || (cursorMoved && !Same(Cursor(), commanded)))
                    throw new InvalidOperationException("The cursor or display was changed during the test.");
            };
            Action<Point> move = delegate(Point point) {
                check();
                if (!SetCursorPos(point.X, point.Y) || !Same(Cursor(), point))
                    throw new InvalidOperationException("Cannot move the cursor to the planned test point.");
                commanded = point;
                cursorMoved = true;
            };
            Action<string, int> sample = delegate(string phase, int trial) {
                check();
                result.Samples.Add(new Sample { Phase = phase, Trial = trial, ElapsedMs = clock.Elapsed.TotalMilliseconds,
                    Cursor = Cursor(), Window = Bounds(pet) });
            };
            Action press = delegate {
                Rect rect = Bounds(pet);
                var grab = new Point(rect.Left + result.GrabOffset.X, rect.Top + result.GrabOffset.Y);
                if (Root(WindowFromPoint(grab)) != pet || (GetAsyncKeyState(1) & 0x8000) != 0)
                    throw new InvalidOperationException("The grab point is blocked or the mouse is in use.");
                move(grab);
                if (Root(WindowFromPoint(Cursor())) != pet) throw new InvalidOperationException("Cannot grab the owned pet HWND.");
                Button(2);
                held = true;
                Thread.Sleep(40);
            };
            Func<double, double, Point> pointAt = (x, y) => new Point(work.Left + Math.Max(4, Math.Min(width - 4, (int)(width * x))),
                work.Top + Math.Max(4, Math.Min(height - 4, (int)(height * y))));
            Action<Point, int, int> glide = delegate(Point to, int duration, int trial) {
                Point from = Cursor();
                var travel = Stopwatch.StartNew();
                do {
                    double fraction = Math.Min(1, travel.Elapsed.TotalMilliseconds / duration);
                    move(new Point((int)Math.Round(from.X + (to.X - from.X) * fraction), (int)Math.Round(from.Y + (to.Y - from.Y) * fraction)));
                    Thread.Sleep(16);
                    sample("motion", trial);
                } while (travel.ElapsedMilliseconds < duration);
                move(to);
            };
            Action<Point, int> dropAndPeel = delegate(Point peel, int trial) {
                sample("drop", trial);
                Button(4);
                held = false;
                move(peel);
                sample("peel", trial);
                for (int poll = 0; poll < 18; poll++) {
                    Thread.Sleep(25);
                    sample(poll == 17 ? "settled" : "release", trial);
                }
            };

            press();
            double heldAt = clock.Elapsed.TotalMilliseconds;
            foreach (Point target in new[] { pointAt(0, .52), pointAt(.46, .50), pointAt(1, .62), pointAt(.55, .50),
                                             pointAt(.64, 1), pointAt(.54, .46), pointAt(.34, 0), pointAt(.56, .55) }) {
                glide(target, 10400, 0);
                Thread.Sleep(150);
                sample("checkpoint", 0);
            }
            result.HeldMs = clock.Elapsed.TotalMilliseconds - heldAt;
            dropAndPeel(pointAt(.08, .85), 0);

            for (int trial = 1; trial <= 12; trial++) {
                press();
                bool right = trial % 2 == 1;
                glide(pointAt(right ? .72 : .25, .37 + (trial % 3) * .10), 280, trial);
                dropAndPeel(pointAt(right ? .06 : .95, .83), trial);
            }
        } catch (Exception error) {
            result.Error = error.Message;
        } finally {
            try {
                if (held) Button(4);
                if (cursorMoved && Same(Cursor(), commanded) && !SetCursorPos(original.X, original.Y))
                    throw new InvalidOperationException("Cannot restore the starting cursor position.");
            } catch (Exception error) {
                result.Error = (result.Error == null ? "" : result.Error + " ") + error.Message;
            } finally {
                if (priorDpi != IntPtr.Zero) SetThreadDpiAwarenessContext(priorDpi);
            }
        }
        return result;
    }
}
'@

[DetachymNativeDrag]::Run($OwnerId, $GrabX, $GrabY, $RendererScale, $CancelPath) | ConvertTo-Json -Depth 6 -Compress
