/**
 * The native accessibility engine (Phase 4B) — a CONSTANT program.
 *
 * WHY NATIVE. Until Phase 4B Axon read controls through .NET's managed
 * `System.Windows.Automation` client, and measured on a real machine it is
 * blind to WinUI 3: WhatsApp showed it 8 elements where the operating
 * system's own UI Automation (`IUIAutomation`, UIAutomationCore) exposes
 * 15,727, and on the Dia browser it threw. This program talks to
 * `IUIAutomation` directly, through COM interfaces declared below.
 *
 * WHY THIS SHAPE, AND NOT A C++ HELPER. The repository has no native
 * toolchain: no MSVC, no .NET SDK, no CI to build one. What every Windows
 * machine has is PowerShell and the .NET Framework compiler behind `Add-Type`,
 * which Axon's other desktop programs already use. So the engine is C# COM
 * interop — `[ComImport]` declarations of exactly the native vtables Axon
 * uses, GUIDs verified against the registry — compiled at start from THIS
 * constant. No DLL is shipped or loaded from disk, nothing is built at install
 * time, and the whole of it is readable here.
 *
 * WHAT IT CAN DO, AND NOTHING MORE:
 *
 *   ping      answer, so the caller knows the engine compiled and COM works
 *   observe   one window's controls: a page of them, optionally only beneath
 *             one control Axon already described
 *   act       one of invoke / toggle / select / expand / setText / focus /
 *             scrollDown / scrollUp, on one control re-found by identity
 *   page      a browser window's web page: its title, its address, and its
 *             text, bounded (the Document's own Value and Text patterns)
 *
 * It reads requests as JSON lines on STDIN and answers on STDOUT. There is no
 * socket, no port, no pipe name another process could open: stdin and stdout
 * are anonymous pipes owned by the parent that started it. Every field of a
 * request is validated here AND by the caller; a request that is not exactly
 * one of the three shapes is answered with an error, never interpreted.
 *
 * NOTHING IS EVALUATED. No request field is ever code, a path, a class name,
 * a COM class or a command. The only COM class this program creates is the
 * constant CUIAutomation CLSID, once.
 *
 * COM AND THREADS. One process, one thread: the loop below, on the process's
 * main thread, started MTA (`-MTA`) as Microsoft recommends for UI
 * Automation clients. The IUIAutomation object, one filter condition and one
 * cache request are created once and live for the process. Every element
 * object is local to one request and released at its end — Axon never holds a
 * COM element across requests; a later request re-finds its control.
 *
 * BOUNDED. A read walks the filtered tree in order and STOPS once it has the
 * page and one more (which is what makes `hasMore` exact). A walk also stops
 * at a node limit and a time budget, and says so rather than pretending the
 * page was complete. Measured on WhatsApp: page 1 in about 0.6 s visiting
 * ~200 nodes, where collecting every match first took 12.3 s.
 *
 * `architecture.test.ts` asserts the absence of `${` here, pins the one
 * CLSID, and bounds the program's length (it travels on a command line).
 */
export const UIA_HOST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace AxonUia {
  [ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IUIAutomation {
    void _CompareElements(); void _CompareRuntimeIds(); void _GetRootElement(); void _ElementFromHandle();
    void _ElementFromPoint(); void _GetFocusedElement(); void _GetRootElementBuildCache();
    [PreserveSig] int ElementFromHandleBuildCache(IntPtr hwnd, IUIAutomationCacheRequest cache, out IUIAutomationElement element);
    void _ElementFromPointBuildCache(); void _GetFocusedElementBuildCache();
    [PreserveSig] int CreateTreeWalker(IUIAutomationCondition condition, out IUIAutomationTreeWalker walker);
    void _ControlViewWalker(); void _ContentViewWalker(); void _RawViewWalker();
    void _RawViewCondition(); void _ControlViewCondition(); void _ContentViewCondition();
    [PreserveSig] int CreateCacheRequest(out IUIAutomationCacheRequest request);
    void _CreateTrueCondition(); void _CreateFalseCondition();
    [PreserveSig] int CreatePropertyCondition(int propertyId, [MarshalAs(UnmanagedType.Struct)] object value, out IUIAutomationCondition condition);
    void _CreatePropertyConditionEx();
    [PreserveSig] int CreateAndCondition(IUIAutomationCondition a, IUIAutomationCondition b, out IUIAutomationCondition condition);
    void _CreateAndConditionFromArray(); void _CreateAndConditionFromNativeArray();
    [PreserveSig] int CreateOrCondition(IUIAutomationCondition a, IUIAutomationCondition b, out IUIAutomationCondition condition);
    void _CreateOrConditionFromArray(); void _CreateOrConditionFromNativeArray();
    [PreserveSig] int CreateNotCondition(IUIAutomationCondition a, out IUIAutomationCondition condition);
  }
  [ComImport, Guid("352ffba8-0973-437c-a61f-f64cafd81df9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IUIAutomationCondition { }
  [ComImport, Guid("b32a92b5-bc25-4078-9c08-d7ee95c48e03"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IUIAutomationCacheRequest { [PreserveSig] int AddProperty(int propertyId); }
  [ComImport, Guid("4042c624-389c-4afc-a630-9df854a541fc"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IUIAutomationTreeWalker {
    void _GetParentElement(); void _GetFirstChildElement(); void _GetLastChildElement();
    void _GetNextSiblingElement(); void _GetPreviousSiblingElement(); void _NormalizeElement(); void _GetParentElementBuildCache();
    [PreserveSig] int GetFirstChildElementBuildCache(IUIAutomationElement element, IUIAutomationCacheRequest cache, out IUIAutomationElement first);
    void _GetLastChildElementBuildCache();
    [PreserveSig] int GetNextSiblingElementBuildCache(IUIAutomationElement element, IUIAutomationCacheRequest cache, out IUIAutomationElement next);
  }
  [ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IUIAutomationElement {
    [PreserveSig] int SetFocus();
    [PreserveSig] int GetRuntimeId([MarshalAs(UnmanagedType.SafeArray, SafeArraySubType = VarEnum.VT_I4)] out int[] runtimeId);
    void _FindFirst(); void _FindAll(); void _FindFirstBuildCache(); void _FindAllBuildCache(); void _BuildUpdatedCache();
    [PreserveSig] int GetCurrentPropertyValue(int propertyId, [MarshalAs(UnmanagedType.Struct)] out object value);
    void _GetCurrentPropertyValueEx();
    [PreserveSig] int GetCachedPropertyValue(int propertyId, [MarshalAs(UnmanagedType.Struct)] out object value);
    void _GetCachedPropertyValueEx(); void _GetCurrentPatternAs(); void _GetCachedPatternAs();
    [PreserveSig] int GetCurrentPattern(int patternId, [MarshalAs(UnmanagedType.IUnknown)] out object pattern);
  }
  [ComImport, Guid("fb377fbe-8ea6-46d5-9c73-6499642d3059"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IUIAutomationInvokePattern { [PreserveSig] int Invoke(); }
  [ComImport, Guid("a94cd8b1-0844-4cd6-9d2d-640537ab39e9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IUIAutomationValuePattern {
    [PreserveSig] int SetValue([MarshalAs(UnmanagedType.BStr)] string value);
    [PreserveSig] int get_CurrentValue([MarshalAs(UnmanagedType.BStr)] out string value);
    [PreserveSig] int get_CurrentIsReadOnly(out int readOnly);
  }
  [ComImport, Guid("94cf8058-9b8d-4ab9-8bfd-4cd0a33c8c70"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IUIAutomationTogglePattern { [PreserveSig] int Toggle(); }
  [ComImport, Guid("a8efa66a-0fda-421a-9194-38021f3578ea"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IUIAutomationSelectionItemPattern { [PreserveSig] int Select(); }
  [ComImport, Guid("619be086-1f4e-4ee4-bafa-210128738730"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IUIAutomationExpandCollapsePattern { [PreserveSig] int Expand(); [PreserveSig] int Collapse(); }
  [ComImport, Guid("32eba289-3583-42c9-9c59-3b6d9a1e9b6a"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IUIAutomationTextPattern { void _RangeFromPoint(); void _RangeFromChild(); void _GetSelection(); void _GetVisibleRanges(); [PreserveSig] int get_DocumentRange(out IUIAutomationTextRange range); }
  [ComImport, Guid("a543cc6a-f4ae-494b-8239-c814481187a8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IUIAutomationTextRange { void _Clone(); void _Compare(); void _CompareEndpoints(); void _ExpandToEnclosingUnit(); void _FindAttribute(); void _FindText(); void _GetAttributeValue(); void _GetBoundingRectangles(); void _GetEnclosingElement(); [PreserveSig] int GetText(int max, [MarshalAs(UnmanagedType.BStr)] out string text); }
  [ComImport, Guid("88f4d42a-e881-459d-a77c-73bbbb7e02dc"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IUIAutomationScrollPattern { [PreserveSig] int Scroll(int h, int v); void _SetScrollPercent(); void _H(); [PreserveSig] int get_CurrentVerticalScrollPercent(out double v); }

  public static class Engine {
    const int Descendants = 4, MaxVisits = 40000, BudgetMs = 4000;
    const int P_RuntimeId = 30000, P_Type = 30003, P_Name = 30005, P_Focusable = 30009, P_Enabled = 30010, P_Id = 30011, P_Class = 30012,
      P_Password = 30019, P_Offscreen = 30022, P_Invoke = 30031, P_Select = 30036, P_Expand = 30028, P_Toggle = 30041,
      P_Value = 30043, P_ValueValue = 30045, P_ReadOnly = 30046;
    const int Pat_Invoke = 10000, Pat_Value = 10002, Pat_Scroll = 10004, Pat_Expand = 10005, Pat_Select = 10010, Pat_Text = 10014, Pat_Toggle = 10015;
    const string CUIAutomation = "ff48dba4-60ef-4201-aa87-54103eef594e";

    // Control types Axon names, by UIA id. Interactive ones map to a role; the
    // rest are containers a read may be scoped beneath, described but never acted on.
    static readonly Dictionary<int, string> Names = new Dictionary<int, string> {
      { 50000, "Button" }, { 50002, "CheckBox" }, { 50003, "ComboBox" }, { 50004, "Edit" }, { 50005, "Hyperlink" },
      { 50007, "ListItem" }, { 50008, "List" }, { 50009, "Menu" }, { 50011, "MenuItem" }, { 50013, "RadioButton" },
      { 50018, "Tab" }, { 50019, "TabItem" }, { 50021, "ToolBar" }, { 50023, "Tree" }, { 50024, "TreeItem" },
      { 50026, "Group" }, { 50028, "DataGrid" }, { 50029, "DataItem" }, { 50030, "Document" }, { 50031, "SplitButton" },
      { 50033, "Pane" }, { 50036, "Table" } };
    static readonly Dictionary<int, string> Roles = new Dictionary<int, string> {
      { 50000, "button" }, { 50031, "button" }, { 50005, "link" }, { 50004, "textbox" }, { 50030, "textbox" },
      { 50002, "checkbox" }, { 50013, "radio" }, { 50011, "menuitem" }, { 50007, "listitem" }, { 50024, "listitem" },
      { 50029, "listitem" }, { 50019, "tab" }, { 50003, "combobox" } };
    static readonly HashSet<int> Containers = new HashSet<int> { 50008, 50009, 50018, 50021, 50023, 50026, 50028, 50030, 50033, 50036 };

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    delegate bool ChildProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, ChildProc f, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
    // Chromium's page surfaces inside a browser window: where its page accessibility lives when the shell does not parent it.
    static List<long> Surfaces(long hwnd) {
      var r = new List<long>();
      EnumChildWindows(new IntPtr(hwnd), (h, l) => { var c = new System.Text.StringBuilder(64); GetClassName(h, c, 64); if (c.ToString() == "Chrome_RenderWidgetHostHWND") r.Add(h.ToInt64()); return true; }, IntPtr.Zero);
      return r;
    }
    public static long Foreground() { return GetForegroundWindow().ToInt64(); }

    static IUIAutomation automation;
    static IUIAutomationCondition filter;
    static IUIAutomationCacheRequest cache;
    static IUIAutomationTreeWalker labels;

    static void Check(int hr) { if (hr < 0) Marshal.ThrowExceptionForHR(hr); }

    public static void Initialize() {
      if (automation != null) return;
      automation = (IUIAutomation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid(CUIAutomation)));
      IUIAutomationCondition types = null;
      foreach (int type in Names.Keys) {
        IUIAutomationCondition one; Check(automation.CreatePropertyCondition(P_Type, type, out one));
        if (types == null) { types = one; } else { IUIAutomationCondition either; Check(automation.CreateOrCondition(types, one, out either)); types = either; }
      }
      IUIAutomationCondition onscreen; Check(automation.CreatePropertyCondition(P_Offscreen, false, out onscreen));
      Check(automation.CreateAndCondition(types, onscreen, out filter));
      Check(automation.CreateCacheRequest(out cache));
      // Named text, for labelling an icon-and-label control that has no name of its own.
      IUIAutomationCondition text; Check(automation.CreatePropertyCondition(P_Type, 50020, out text));
      IUIAutomationCondition blank; Check(automation.CreatePropertyCondition(P_Name, "", out blank));
      IUIAutomationCondition named; Check(automation.CreateNotCondition(blank, out named));
      IUIAutomationCondition label; Check(automation.CreateAndCondition(text, named, out label));
      Check(automation.CreateTreeWalker(label, out labels));
      foreach (int p in new int[] { P_Type, P_Name, P_Focusable, P_Enabled, P_Id, P_Class, P_Password, P_Offscreen,
        P_Invoke, P_Select, P_Expand, P_Toggle, P_Value, P_ValueValue, P_ReadOnly }) Check(cache.AddProperty(p));
    }

    static object Cached(IUIAutomationElement e, int id) { object v; return e.GetCachedPropertyValue(id, out v) >= 0 ? v : null; }
    static bool Flag(IUIAutomationElement e, int id) { object v = Cached(e, id); return v is bool && (bool)v; }
    static string Text(IUIAutomationElement e, int id) { object v = Cached(e, id); return v as string ?? ""; }
    static int TypeOf(IUIAutomationElement e) { object v = Cached(e, P_Type); return v is int ? (int)v : 0; }
    static string NativeRole(int type) { string n; return Names.TryGetValue(type, out n) ? "ControlType." + n : ""; }
    // A control's name, or — when it has none — the first named text INSIDE it:
    // the label of an icon-and-label button (measured: half of Dia's unnamed
    // buttons carry one). One first-child step on a text-only walker, so the
    // search never leaves the control's own subtree. Still text the
    // application wrote, and treated exactly like any other name.
    static string Label(IUIAutomationElement e) {
      string name = Text(e, P_Name);
      if (name.Trim().Length > 0) return name;
      IUIAutomationElement inner;
      if (labels.GetFirstChildElementBuildCache(e, cache, out inner) >= 0 && inner != null) return Text(inner, P_Name);
      return "";
    }

    static string RuntimeId(IUIAutomationElement e) {
      int[] id; if (e.GetRuntimeId(out id) < 0 || id == null) return "";
      return string.Join(".", Array.ConvertAll(id, x => x.ToString()));
    }

    // One element as Axon describes it, or null when it is neither actionable nor a named container.
    static Dictionary<string, object> Describe(IUIAutomationElement e) {
      int type = TypeOf(e);
      if (!Names.ContainsKey(type)) return null;
      string name = Text(e, P_Name);
      if (name.Trim().Length == 0 && Roles.ContainsKey(type)) name = Label(e);
      if (name.Trim().Length == 0) return null;
      var actions = new List<string>();
      if (Flag(e, P_Enabled)) {
        if (Flag(e, P_Invoke)) actions.Add("invoke");
        if (Flag(e, P_Toggle)) actions.Add("toggle");
        if (Flag(e, P_Select)) actions.Add("select");
        if (Flag(e, P_Expand)) actions.Add("expand");
        if (Flag(e, P_Value)) { object ro = Cached(e, P_ReadOnly); if (ro is bool && !(bool)ro) actions.Add("setText"); }
        if (Flag(e, P_Focusable)) actions.Add("focus");
      }
      string role;
      bool actionable = Roles.TryGetValue(type, out role) && actions.Count > 0;
      if (!actionable && !Containers.Contains(type)) return null;
      bool sensitive = Flag(e, P_Password);
      var c = new Dictionary<string, object>();
      c["nativeRole"] = NativeRole(type);
      c["role"] = actionable ? role : "container";
      c["name"] = name;
      c["automationId"] = Text(e, P_Id);
      c["className"] = Text(e, P_Class);
      c["runtimeId"] = RuntimeId(e);
      c["sensitive"] = sensitive;
      c["actions"] = actionable ? actions.ToArray() : new string[0];
      // A protected field's content is never read, whatever it reports.
      c["value"] = actionable && actions.Contains("setText") && !sensitive ? Text(e, P_ValueValue) : null;
      return c;
    }

    // In-order walk over the filtered view beneath one element. The visitor returns false to stop.
    //
    // CONTAINED. A filtered walker navigates the FILTERED tree: if the element
    // the walk starts from did not itself satisfy the filter (a window root
    // never does), its first matches would have the DESKTOP as their parent,
    // and their "next siblings" would be other windows' controls. Measured on
    // a test window, it happened. So the walk's condition is the filter OR
    // exactly this start element, by its runtime id: the start is always in
    // the view, and every sibling step stays beneath it.
    static bool Walk(IUIAutomationElement from, Func<IUIAutomationElement, bool> visit, out int visited, out bool exhausted) {
      var watch = System.Diagnostics.Stopwatch.StartNew();
      int[] fromId; Check(from.GetRuntimeId(out fromId));
      if (fromId == null || fromId.Length == 0) throw new COMException("no runtime id");
      IUIAutomationCondition self; Check(automation.CreatePropertyCondition(P_RuntimeId, fromId, out self));
      IUIAutomationCondition contained; Check(automation.CreateOrCondition(self, filter, out contained));
      IUIAutomationTreeWalker walker; Check(automation.CreateTreeWalker(contained, out walker));
      var pending = new Stack<IUIAutomationElement>();
      IUIAutomationElement first; walker.GetFirstChildElementBuildCache(from, cache, out first);
      if (first != null) pending.Push(first);
      visited = 0; exhausted = false;
      while (pending.Count > 0) {
        if (visited >= MaxVisits || watch.ElapsedMilliseconds > BudgetMs) { exhausted = true; return true; }
        var e = pending.Pop(); visited++;
        IUIAutomationElement next; walker.GetNextSiblingElementBuildCache(e, cache, out next);
        if (next != null) pending.Push(next);
        IUIAutomationElement child; walker.GetFirstChildElementBuildCache(e, cache, out child);
        if (child != null) pending.Push(child);
        if (!visit(e)) return false;
      }
      return true;
    }

    // Re-find one element by identity. An exact runtime-id match (a live element is unique by it) ends the
    // search; otherwise exactly one identity match is the element, none is gone, several are ambiguous.
    static IUIAutomationElement Find(IUIAutomationElement root, Dictionary<string, object> want, out string error) {
      string role = Str(want, "role"), name = Str(want, "name"), id = Str(want, "automationId"), rid = Str(want, "runtimeId");
      IUIAutomationElement exact = null, only = null; int matches = 0;
      int visited; bool exhausted;
      Walk(root, e => {
        if (NativeRole(TypeOf(e)) != role || Text(e, P_Id) != id) return true;
        string own = Text(e, P_Name);
        if (own != name && !(own.Trim().Length == 0 && Roles.ContainsKey(TypeOf(e)) && Label(e) == name)) return true;
        if (rid.Length > 0 && RuntimeId(e) == rid) { exact = e; return false; }
        matches++; only = e; return true;
      }, out visited, out exhausted);
      error = null;
      if (exact != null) return exact;
      if (exhausted) { error = "gone"; return null; }
      if (matches == 1) return only;
      error = matches == 0 ? "gone" : "ambiguous";
      return null;
    }

    static IUIAutomationElement Root(long hwnd) {
      IUIAutomationElement root;
      return automation.ElementFromHandleBuildCache(new IntPtr(hwnd), cache, out root) >= 0 ? root : null;
    }

    public static Dictionary<string, object> Observe(long hwnd, int skip, int max, Dictionary<string, object> scope) {
      var watch = System.Diagnostics.Stopwatch.StartNew();
      var r = new Dictionary<string, object>();
      IUIAutomationElement root = Root(hwnd);
      if (root == null) { r["error"] = "gone"; return r; }
      IUIAutomationElement from = root;
      if (scope != null) {
        string error; from = Find(root, scope, out error);
        if (from == null) { r["error"] = "scope-" + error; return r; }
      }
      var found = new List<object>(); int qualified = 0; bool hasMore = false;
      int visited; bool exhausted;
      Walk(from, e => {
        var c = Describe(e);
        if (c == null) return true;
        if (qualified < skip) { qualified++; return true; }
        if (found.Count >= max) { hasMore = true; return false; }
        qualified++; found.Add(c); return true;
      }, out visited, out exhausted);
      r["window"] = Text(root, P_Name);
      r["handle"] = hwnd.ToString();
      r["offset"] = skip;
      r["elements"] = found.ToArray();
      // Stopped by the bound, not by the end of the tree: said, never hidden.
      r["incomplete"] = exhausted;
      r["hasMore"] = hasMore || exhausted;
      r["truncated"] = hasMore || exhausted;
      r["visited"] = visited;
      r["ms"] = watch.ElapsedMilliseconds;
      return r;
    }

    static string ValueOf(IUIAutomationElement e) { object v; string s; return e.GetCurrentPattern(Pat_Value, out v) >= 0 && v != null && ((IUIAutomationValuePattern)v).get_CurrentValue(out s) >= 0 ? s : null; }

    // The web page in a browser window: the first Document whose Value is an http(s) address. Read-only.
    public static Dictionary<string, object> Page(long hwnd, int max) {
      var r = new Dictionary<string, object>();
      if (Root(hwnd) == null) { r["error"] = "gone"; return r; }
      IUIAutomationElement doc = null; string url = null; long surface = 0; int visited; bool exhausted;
      var tries = new List<long> { hwnd }; tries.AddRange(Surfaces(hwnd));
      foreach (long h in tries) {
        IUIAutomationElement root = Root(h); if (root == null) continue;
        Walk(root, e => { if (TypeOf(e) != 50030) return true; string u = ValueOf(e); if (u == null || !Regex.IsMatch(u, "^https?://", RegexOptions.IgnoreCase)) return true; doc = e; url = u; return false; }, out visited, out exhausted);
        if (doc != null) { surface = h; break; }
      }
      if (doc == null) { r["error"] = "no-page"; return r; }
      r["surface"] = surface.ToString();
      r["title"] = Text(doc, P_Name); r["url"] = url; r["runtimeId"] = RuntimeId(doc); r["automationId"] = Text(doc, P_Id);
      object p; string text = null; IUIAutomationTextRange range;
      if (doc.GetCurrentPattern(Pat_Text, out p) >= 0 && p != null && ((IUIAutomationTextPattern)p).get_DocumentRange(out range) >= 0 && range != null) range.GetText(max, out text);
      r["text"] = text;
      double pos = -1; if (doc.GetCurrentPattern(Pat_Scroll, out p) >= 0 && p != null) ((IUIAutomationScrollPattern)p).get_CurrentVerticalScrollPercent(out pos);
      r["scroll"] = pos;
      return r;
    }

    public static Dictionary<string, object> Act(long hwnd, Dictionary<string, object> target) {
      var r = new Dictionary<string, object>();
      IUIAutomationElement root = Root(hwnd);
      if (root == null) { r["error"] = "gone"; return r; }
      string error; IUIAutomationElement e = Find(root, target, out error);
      if (e == null) { r["error"] = error; return r; }
      // The last refusal of a credential field, from the application's own, current report.
      object password; if (e.GetCurrentPropertyValue(P_Password, out password) >= 0 && password is bool && (bool)password) { r["error"] = "sensitive"; return r; }
      string action = Str(target, "action");
      object pattern; int hr;
      switch (action) {
        case "invoke": hr = e.GetCurrentPattern(Pat_Invoke, out pattern); if (hr < 0 || pattern == null) goto unsupported; hr = ((IUIAutomationInvokePattern)pattern).Invoke(); break;
        case "toggle": hr = e.GetCurrentPattern(Pat_Toggle, out pattern); if (hr < 0 || pattern == null) goto unsupported; hr = ((IUIAutomationTogglePattern)pattern).Toggle(); break;
        case "select": hr = e.GetCurrentPattern(Pat_Select, out pattern); if (hr < 0 || pattern == null) goto unsupported; hr = ((IUIAutomationSelectionItemPattern)pattern).Select(); break;
        case "expand": hr = e.GetCurrentPattern(Pat_Expand, out pattern); if (hr < 0 || pattern == null) goto unsupported; hr = ((IUIAutomationExpandCollapsePattern)pattern).Expand(); break;
        case "focus": hr = e.SetFocus(); break;
        case "scrollDown": case "scrollUp": hr = e.GetCurrentPattern(Pat_Scroll, out pattern); if (hr < 0 || pattern == null) goto unsupported; hr = ((IUIAutomationScrollPattern)pattern).Scroll(2, action == "scrollDown" ? 3 : 0); break;
        case "setText": {
          hr = e.GetCurrentPattern(Pat_Value, out pattern); if (hr < 0 || pattern == null) goto unsupported;
          var value = (IUIAutomationValuePattern)pattern; int readOnly;
          if (value.get_CurrentIsReadOnly(out readOnly) < 0 || readOnly != 0) goto unsupported;
          hr = value.SetValue(Str(target, "text")); break;
        }
        default: r["error"] = "unknown-action"; return r;
      }
      if (hr < 0) goto unsupported;
      // Read the value back where there is one: evidence, not the absence of an exception.
      object after = null; object v; if (e.GetCurrentPattern(Pat_Value, out v) >= 0 && v != null) { string s; if (((IUIAutomationValuePattern)v).get_CurrentValue(out s) >= 0) after = s; }
      r["ok"] = true; r["value"] = after; return r;
      unsupported:
      r["error"] = "unsupported"; return r;
    }

    static string Str(Dictionary<string, object> d, string key) { object v; return d != null && d.TryGetValue(key, out v) && v is string ? (string)v : ""; }
  }

  // The request loop. One request per line in, one answer per line out, in order.
  public static class Host {
    const int MaxLine = 65536;
    static readonly Regex RequestId = new Regex("^[A-Za-z0-9-]{1,64}$");
    static readonly Regex Handle = new Regex("^[0-9]{0,19}$");
    static readonly Regex Runtime = new Regex("^[0-9-]{1,11}(\\.[0-9-]{1,11}){0,15}$");
    static readonly HashSet<string> Actions = new HashSet<string> { "invoke", "toggle", "select", "expand", "setText", "focus", "scrollDown", "scrollUp" };

    public static void Serve() {
      var json = new JavaScriptSerializer(); json.MaxJsonLength = 8 * 1024 * 1024;
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        Dictionary<string, object> answer;
        if (line.Length > MaxLine) answer = Fail(null, "too-large");
        else {
          Dictionary<string, object> request = null;
          try { request = json.Deserialize<Dictionary<string, object>>(line); } catch (Exception) { }
          answer = request == null ? Fail(null, "malformed") : Dispatch(request);
        }
        Console.Out.WriteLine(json.Serialize(answer));
        Console.Out.Flush();
        // No element outlives its request: release every wrapper now, not whenever the GC gets to it.
        GC.Collect(); GC.WaitForPendingFinalizers();
      }
    }

    static Dictionary<string, object> Fail(string id, string error) {
      var r = new Dictionary<string, object>(); r["id"] = id; r["error"] = error; return r;
    }

    static bool Identity(object value, bool withAction, out Dictionary<string, object> identity) {
      identity = value as Dictionary<string, object>;
      if (identity == null) return false;
      foreach (var key in identity.Keys) {
        if (key != "role" && key != "name" && key != "automationId" && key != "runtimeId" && !(withAction && (key == "action" || key == "text"))) return false;
        if (!(identity[key] is string)) return false;
      }
      object role; if (!identity.TryGetValue("role", out role) || !((string)role).StartsWith("ControlType.") || ((string)role).Length > 64) return false;
      object name; if (identity.TryGetValue("name", out name) && ((string)name).Length > 1024) return false;
      object aid; if (identity.TryGetValue("automationId", out aid) && ((string)aid).Length > 512) return false;
      object rid; if (identity.TryGetValue("runtimeId", out rid) && ((string)rid).Length > 0 && !Runtime.IsMatch((string)rid)) return false;
      if (withAction) {
        object action; if (!identity.TryGetValue("action", out action) || !Actions.Contains((string)action)) return false;
        object text; if (identity.TryGetValue("text", out text) && ((string)text).Length > 20000) return false;
      }
      return true;
    }

    static int Integer(object value, int min, int max, int fallback) {
      if (value == null) return fallback;
      if (!(value is int)) return int.MinValue;
      int n = (int)value; return n < min || n > max ? int.MinValue : n;
    }

    static Dictionary<string, object> Dispatch(Dictionary<string, object> request) {
      object idValue; request.TryGetValue("id", out idValue);
      string id = idValue as string;
      if (id == null || !RequestId.IsMatch(id)) return Fail(null, "invalid");
      object op; request.TryGetValue("op", out op);
      foreach (var key in request.Keys) {
        if (key != "id" && key != "op" && key != "window" && key != "skip" && key != "max" && key != "scope" && key != "target") return Fail(id, "invalid");
      }
      try {
        Engine.Initialize();
      } catch (Exception) {
        return Fail(id, "com");
      }
      if ((op as string) == "ping") { var pong = new Dictionary<string, object>(); pong["id"] = id; pong["ok"] = true; return pong; }
      object windowValue; request.TryGetValue("window", out windowValue);
      string window = windowValue as string;
      if (window == null || !Handle.IsMatch(window)) return Fail(id, "invalid");
      // Empty means the window in front, as the operating system reports it now.
      long hwnd = window.Length == 0 ? Engine.Foreground() : long.Parse(window);
      if (hwnd == 0) return Fail(id, "gone");
      try {
        Dictionary<string, object> result;
        if ((op as string) == "observe") {
          object skipValue; request.TryGetValue("skip", out skipValue);
          object maxValue; request.TryGetValue("max", out maxValue);
          int skip = Integer(skipValue, 0, 1140, 0), max = Integer(maxValue, 1, 60, 60);
          if (skip == int.MinValue || max == int.MinValue) return Fail(id, "invalid");
          Dictionary<string, object> scope = null;
          object scopeValue; if (request.TryGetValue("scope", out scopeValue) && scopeValue != null && !Identity(scopeValue, false, out scope)) return Fail(id, "invalid");
          result = Engine.Observe(hwnd, skip, max, scope);
        } else if ((op as string) == "act") {
          object targetValue; request.TryGetValue("target", out targetValue);
          Dictionary<string, object> target;
          if (!Identity(targetValue, true, out target)) return Fail(id, "invalid");
          result = Engine.Act(hwnd, target);
        } else if ((op as string) == "page") {
          object maxValue; request.TryGetValue("max", out maxValue);
          int max = Integer(maxValue, 1, 60000, 20000);
          if (max == int.MinValue) return Fail(id, "invalid");
          result = Engine.Page(hwnd, max);
        } else {
          return Fail(id, "unknown-op");
        }
        result["id"] = id;
        return result;
      } catch (COMException) {
        // An element that vanished mid-read, a window that closed, an application that exited.
        return Fail(id, "gone");
      } catch (InvalidCastException) {
        return Fail(id, "unsupported");
      } catch (Exception) {
        return Fail(id, "failed");
      }
    }
  }
}
'@
[AxonUia.Host]::Serve()
`;
