import AppKit
import Carbon.HIToolbox
import WebKit

private final class CompanionPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    /// AppKit keeps every window's top under the menu bar. His window is taller than he
    /// is (room for speech above his hair), so that empty top hit the menu bar first and
    /// his head never got closer than a hand's width. The shell keeps him on screen itself.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
    override var canBecomeMain: Bool { false }
}

/// Avoids WKUserContentController keeping the app delegate alive forever.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

/// Everything she can change about how much room the pet takes up.
/// Stored in UserDefaults so the pet comes back the way she left it.
private struct CompanionPreferences {
    private let defaults = UserDefaults.standard

    static let scales: [(String, CGFloat)] = [("小", 0.4), ("中", 0.6), ("原始大小", 1.0)]
    static let opacities: [(String, CGFloat)] = [("不透明", 1.0), ("半透明", 0.65), ("很淡", 0.35)]

    var scale: CGFloat {
        get { let v = defaults.double(forKey: "scale"); return v > 0 ? CGFloat(v) : 0.6 }
        nonmutating set { defaults.set(Double(newValue), forKey: "scale") }
    }
    var opacity: CGFloat {
        get { let v = defaults.double(forKey: "opacity"); return v > 0 ? CGFloat(v) : 1.0 }
        nonmutating set { defaults.set(Double(newValue), forKey: "opacity") }
    }
    var alwaysOnTop: Bool {
        get { defaults.object(forKey: "alwaysOnTop") as? Bool ?? true }
        nonmutating set { defaults.set(newValue, forKey: "alwaysOnTop") }
    }
    var clickThrough: Bool {
        get { defaults.bool(forKey: "clickThrough") }
        nonmutating set { defaults.set(newValue, forKey: "clickThrough") }
    }
    var wanders: Bool {
        get { defaults.object(forKey: "wanders") as? Bool ?? true }
        nonmutating set { defaults.set(newValue, forKey: "wanders") }
    }
    var climbsWindows: Bool {
        get { defaults.object(forKey: "climbsWindows") as? Bool ?? true }
        nonmutating set { defaults.set(newValue, forKey: "climbsWindows") }
    }
    static let outfits: [(String, String)] = [
        ("自动（出门穿他自己挑的，在家白天便服、夜里睡衣）", "auto"),
        ("海军蓝风衣+格子围巾", "coat"), ("米色雨衣", "raincoat"), ("粗花呢外套", "tweed"),
        ("圣诞毛衣", "jumper"), ("金融城绅士（圆顶礼帽）", "city"), ("红色礼服", "dress"),
        ("海盗船长", "pirate"), ("七十年代朋克", "punk"), ("旧军装风衣", "trench"), ("居家便服", "homewear"), ("条纹睡衣", "pajamas"),
        ("学院袍", "gown"), ("园艺装", "garden"), ("不列颠天使", "angel"), ("乡村蜡夹克", "barbour"), ("女仆装", "maid"),
    ]
    var outfit: String {
        get { defaults.string(forKey: "outfit") ?? "auto" }
        nonmutating set { defaults.set(newValue, forKey: "outfit") }
    }
    /// When the outfit she put on him may come off (seconds since 1970); nil = no limit.
    var outfitUntil: Double? {
        get { defaults.object(forKey: "outfitUntil") as? Double }
        nonmutating set { defaults.set(newValue, forKey: "outfitUntil") }
    }
    /// While she has sent him away: when he comes back (seconds since 1970),
    /// or 0 for "when I call you". nil = not away.
    var awayUntil: Double? {
        get { defaults.object(forKey: "awayUntil") as? Double }
        nonmutating set { defaults.set(newValue, forKey: "awayUntil") }
    }
    /// The id of the last message from him she marked as read on the pet.
    var letterRead: String {
        get { defaults.string(forKey: "letterRead") ?? "" }
        nonmutating set { defaults.set(newValue, forKey: "letterRead") }
    }
    /// The day (yyyy-MM-dd, local) he last said good morning/evening to her.
    var lastGreetDay: String {
        get { defaults.string(forKey: "lastGreetDay") ?? "" }
        nonmutating set { defaults.set(newValue, forKey: "lastGreetDay") }
    }
    /// How many head pats (he gets used to those too).
    var patCount: Int {
        get { defaults.integer(forKey: "patCount") }
        nonmutating set { defaults.set(newValue, forKey: "patCount") }
    }
    /// How many times she's touched his body (he gets used to it).
    var touchCount: Int {
        get { defaults.integer(forKey: "touchCount") }
        nonmutating set { defaults.set(newValue, forKey: "touchCount") }
    }
    /// What he has on him (the page's pocket list, as JSON).
    var pockets: String {
        get { defaults.string(forKey: "pockets") ?? "" }
        nonmutating set { defaults.set(newValue, forKey: "pockets") }
    }
    /// Small things the page wants remembered (JSON object), e.g. today's grudges.
    var pageKV: String {
        get { defaults.string(forKey: "pageKV") ?? "{}" }
        nonmutating set { defaults.set(newValue, forKey: "pageKV") }
    }
    var awaySide: Double {
        get { defaults.object(forKey: "awaySide") as? Double ?? 1 }
        nonmutating set { defaults.set(newValue, forKey: "awaySide") }
    }
    static let glassesModes: [(String, String)] = [("偶尔（出门、看书时随他）", "auto"), ("一直戴", "on"), ("不戴", "off")]
    var glasses: String {
        get { defaults.string(forKey: "glasses") ?? "auto" }
        nonmutating set { defaults.set(newValue, forKey: "glasses") }
    }
    var hidden: Bool {
        get { defaults.bool(forKey: "hidden") }
        nonmutating set { defaults.set(newValue, forKey: "hidden") }
    }
    /// Bottom-centre of the window, so resizing keeps him where he was.
    var anchor: NSPoint? {
        get {
            guard let raw = defaults.array(forKey: "anchor") as? [Double], raw.count == 2 else { return nil }
            return NSPoint(x: raw[0], y: raw[1])
        }
        nonmutating set {
            if let p = newValue { defaults.set([Double(p.x), Double(p.y)], forKey: "anchor") }
            else { defaults.removeObject(forKey: "anchor") }
        }
    }
}

/// Something he can stand on: the bottom of a screen, the top of the Dock, or the
/// visible part of a window's top edge.
/// A stolen thing of his, out on the desktop: follows the mouse while held,
/// falls and lies where she lets go, and can be picked up and dragged again.
private final class ItemPanel: NSPanel {
    let label = NSTextField(labelWithString: "")
    var onGrab: (() -> Void)?
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
    init(icon: String, size: CGFloat) {
        super.init(contentRect: NSRect(x: 0, y: 0, width: size, height: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        ignoresMouseEvents = true
        let view = GrabView(frame: NSRect(x: 0, y: 0, width: size, height: size))
        view.onGrab = { [weak self] in self?.onGrab?() }
        label.stringValue = icon
        label.font = NSFont.systemFont(ofSize: size * 0.72)
        label.alignment = .center
        label.frame = NSRect(x: 0, y: size * 0.08, width: size, height: size * 0.9)
        view.addSubview(label)
        contentView = view
    }
    func center(at point: NSPoint) {
        setFrameOrigin(NSPoint(x: point.x - frame.width / 2, y: point.y - frame.height / 2))
    }
    /// The bottom-centre: where it rests on a ledge.
    var foot: NSPoint { NSPoint(x: frame.midX, y: frame.minY) }
    func rest(foot point: NSPoint) { setFrameOrigin(NSPoint(x: point.x - frame.width / 2, y: point.y)) }
}

private final class GrabView: NSView {
    var onGrab: (() -> Void)?
    override func mouseDown(with event: NSEvent) { onGrab?() }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// The page view, which also takes files dropped on him. Only the file's
/// name (and whether it's a folder) is passed on; the file is never opened.
private final class CompanionWebView: WKWebView {
    var onFileHover: ((Bool) -> Void)?
    var onFilesDropped: (([URL]) -> Void)?

    private func files(_ info: NSDraggingInfo) -> [URL] {
        info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
    }
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard !files(sender).isEmpty else { return [] }
        onFileHover?(true)
        return .copy
    }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        files(sender).isEmpty ? [] : .copy
    }
    override func draggingExited(_ sender: NSDraggingInfo?) { onFileHover?(false) }
    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool { !files(sender).isEmpty }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = files(sender)
        guard !urls.isEmpty else { return false }
        onFileHover?(false)
        onFilesDropped?(urls)
        return true
    }
    override func concludeDragOperation(_ sender: NSDraggingInfo?) {}
}

private struct Ledge {
    enum Kind { case floor, dock, window }
    let y: CGFloat
    let minX: CGFloat
    let maxX: CGFloat
    let kind: Kind
    var windowNumber: Int? = nil
    /// Floors stop him at the end; docks and window tops he can stroll off.
    var hasDropAtEnds: Bool { kind != .floor }
}

private enum Motion {
    case resting
    case dragging(offset: NSPoint)
    /// vx: sideways, pt/s (+ right). vy: downward, pt/s (negative = still rising).
    case falling(vx: CGFloat, vy: CGFloat)
    case walking(targetX: CGFloat, direction: CGFloat)
    /// Sent away: walking off the side of the screen.
    case leaving(direction: CGFloat)
    /// Back again: walking in from the side.
    case entering(targetX: CGFloat, direction: CGFloat)
}

final class ArthurDesktopCompanionApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, NSMenuDelegate, WKScriptMessageHandler {
    private static let baseSize = NSSize(width: 390, height: 560)
    private static let hoverFadeAlpha: CGFloat = 0.12
    private static let gravity: CGFloat = 2600      // pt/s²
    private static let walkSpeed: CGFloat = 46      // pt/s at original size

    private var panel: CompanionPanel!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!
    private var retry: DispatchWorkItem?
    private var ticker: Timer?
    private var hotKeys: [EventHotKeyRef?] = []
    private let prefs = CompanionPreferences()
    private let companionURL = URL(string: "http://127.0.0.1:15174/")!

    // Reported by the page, in CSS pixels from the window's top-left.
    private var hitRects: [CGRect] = []
    private var feetCSS: CGPoint?
    private var pageCanWander = false
    private var pageCanSit = false
    private var pageSeated = false
    /// When he sat down on his own, when he means to get up again.
    private var sittingUntil: CFTimeInterval?

    private var motion: Motion = .resting
    private var ledge: Ledge?
    private var lastTick = CACurrentMediaTime()
    private var nextSupportCheck: CFTimeInterval = 0
    private var nextOutfitCheck: CFTimeInterval = 0
    /// Mouse samples while dragging, for the speed he's flung at.
    private var dragSamples: [(t: CFTimeInterval, p: NSPoint)] = []
    private var flungHard = false
    /// Darting away after being touched where he'd rather not be (walks fast).
    private var fleeing = false {
        didSet { if fleeing != oldValue { js("window.ArthurHost && ArthurHost.walkRate && ArthurHost.walkRate(\(fleeing ? (tired ? 1.3 : 2.3) : 1))") } }
    }
    // Stamina: running and climbing use it up, standing about brings it back.
    // He tires at a different point each time (somewhere in 0.2-0.45).
    private var stamina: CGFloat = 1
    private var tiredAt = CGFloat.random(in: 0.15...0.35)
    private var tired = false
    private var catchBreathUntil: CFTimeInterval = 0
    private var nextBreather: CFTimeInterval = 0
    private var nextChaseHop: CFTimeInterval = 0
    /// Walking over to where her cursor is, of his own accord.
    private var visitingCursor = false
    // When she last moved the mouse at all (to tell whether she's at the computer).
    private var lastMouse = NSPoint.zero
    private var lastMouseMoveAt: CFTimeInterval = CACurrentMediaTime()
    private var nextIdleReport: CFTimeInterval = 0

    /// Off to the bottom corner of the screen he's on (late at night, with a blanket).
    /// Off to the snuggest corner he can get to before the blanket comes out:
    /// down off windows (no frightening drops), then along to the nearer side of
    /// the screen. Tells the page once he's there.
    private var cornerSeekUntil: CFTimeInterval?
    private var nextCornerStep: CFTimeInterval = 0
    private func goToCorner() {
        cornerSeekUntil = CACurrentMediaTime() + 60
        nextCornerStep = 0
    }

    private func arrivedInCorner() {
        cornerSeekUntil = nil
        js("window.ArthurHost && ArthurHost.inCorner && ArthurHost.inCorner()")
    }

    private func stepTowardsCorner(now: CFTimeInterval) {
        guard let until = cornerSeekUntil, now >= nextCornerStep else { return }
        nextCornerStep = now + 0.5
        guard case .resting = motion, let ledge, let feet = feetOnScreen() else { return }
        if now > until || stranded || itemState != nil { arrivedInCorner(); return }
        let screen = screenUnderFeet()
        let inset = panel.frame.width * 0.32
        let (lo, hi) = span(of: ledge)
        let nearRight = (screen.maxX - feet.x) < (feet.x - screen.minX)
        var target: CGFloat
        if ledge.hasDropAtEnds {
            // A window: get down if a drop is easy enough, towards the nearer side first.
            let ok = { (x: CGFloat) in self.dropHeight(from: ledge, at: x) <= self.bodyHeight() * 2.0 }
            let ends: [(CGFloat, CGFloat)] = nearRight ? [(hi + 30, hi + 40), (lo - 30, lo - 40)] : [(lo - 30, lo - 40), (hi + 30, hi + 40)]
            if let down = ends.first(where: { ok($0.0) && screen.minX < $0.0 && $0.0 < screen.maxX }) {
                target = down.1
            } else {
                // No easy way down: the end of this window nearest the side will do.
                target = nearRight ? hi - 30 : lo + 30
            }
        } else {
            target = nearRight ? min(hi, screen.maxX) - inset : max(lo, screen.minX) + inset
        }
        if abs(target - feet.x) < 30 { arrivedInCorner(); return }
        let dir: CGFloat = target > feet.x ? 1 : -1
        js("window.ArthurHost ? ArthurHost.walk(\(dir > 0 ? 1 : -1)) : false") { [weak self] ok in
            guard let self, (ok as? Bool) == true, case .resting = self.motion else { return }
            self.motion = .walking(targetX: target, direction: dir)
        }
    }
    /// Got up somewhere high in the heat of a chase; too high to dare jump down.
    private var excitedClimb = false
    private var stranded = false
    private var rescuedPending = false

    /// How far he'd fall stepping off this ledge at x.
    private func dropHeight(from ledge: Ledge, at x: CGFloat) -> CGFloat {
        let below = ledges().filter { $0.y < ledge.y - 2 && $0.minX <= x && x <= $0.maxX }.map(\.y).max() ?? 0
        return ledge.y - below
    }

    /// Whether he dares jump off this end. A dice roll that depends on the drop
    /// (in his own heights): a step down he always takes; higher, he may balk.
    /// The answer holds for a while per edge (he doesn't flip-flop every frame);
    /// when it runs out he looks again, a little braver each time he wants down.
    private struct EdgeDare { let key: String; let until: CFTimeInterval; let dares: Bool; let tries: Int }
    private var edgeDares: [String: EdgeDare] = [:]
    /// Hopping down through the edge he stood on (he's drawn in front of windows).
    private var dropThroughY: CGFloat?
    private var dareBias: Double = 0
    private var dareBiasUntil: CFTimeInterval = 0
    /// Led on: he dared a real drop after his things, and she lifted them straight
    /// back up out of reach. The page decides how he takes it.
    private var braveDropPending = false
    private var braveLandedAt: CFTimeInterval?
    /// Or the other way: he climbed a good way up after them, and down they went.
    private var climbBaseY: CGFloat?
    private var climbBaseAt: CFTimeInterval = 0
    private var climbedAt: CFTimeInterval?
    private var baitCount = 0
    private var chaseRefused = false
    private func dareChance(drop: CGFloat, tries: Int) -> Double {
        let h = Double(drop / max(1, bodyHeight()))
        if h <= 1.5 { return 1 }
        var p = min(1, max(0.08, 1.25 - 0.27 * h))   // 2 → 0.71, 3 → 0.44, 4 → 0.17
        if case .held = itemState { p += 0.2 }        // after her with his things: braver
        p += 0.15 * Double(tries)
        if CACurrentMediaTime() < dareBiasUntil { p += dareBias }   // baited: sore (warier) or riled (bolder)
        return min(1, max(0.05, p))
    }
    private func tooHighToDrop(_ ledge: Ledge, at x: CGFloat) -> Bool {
        guard ledge.kind == .window else { return false }
        // One road, one roll: windows side by side at this height are one edge to him, so
        // the question is always about the end of the whole road (asking per window piece
        // rolled twice at once and he'd decide to jump, walk there, then balk).
        let (lo, hi) = span(of: ledge)
        let side = x < (lo + hi) / 2 ? "L" : "R"
        let endX = side == "L" ? lo - 30 : hi + 30
        let drop = dropHeight(from: ledge, at: endX)
        if drop <= bodyHeight() * 1.5 { return false }
        let key = "\(Int(ledge.y)):\(Int(side == "L" ? lo : hi)):\(side)"
        let now = CACurrentMediaTime()
        if let d = edgeDares[key], now < d.until { return !d.dares }
        let tries = (edgeDares[key].map { now - $0.until < 30 ? $0.tries + 1 : 0 }) ?? 0
        let dares = Double.random(in: 0..<1) < dareChance(drop: drop, tries: tries)
        if dares, itemState != nil { braveDropPending = true }
        // Said yes: good for a moment (enough to get there). Said no: he thinks about it for a while.
        edgeDares[key] = EdgeDare(key: key, until: now + (dares ? 6 : Double.random(in: 6...14)), dares: dares, tries: tries)
        if edgeDares.count > 40 { edgeDares = edgeDares.filter { now - $0.value.until < 30 } }
        NSLog("Arthur at an edge: drop %.1f heights, %@ (try %d)", Double(drop / max(1, bodyHeight())), dares ? "jumps" : "won't", tries)
        return !dares
    }
    /// Down from where he stands, not only off the ends: a little hop, then through the
    /// edge he was on to whatever is below, if he dares that drop.
    @discardableResult
    private func hopDownHere(towards dir: CGFloat = 0) -> Bool {
        guard let ledge, ledge.hasDropAtEnds, let feet = feetOnScreen(), case .resting = motion else { return false }
        let drop = dropHeight(from: ledge, at: feet.x)
        let key = "\(Int(ledge.y)):mid:\(Int(feet.x / 120))"
        let now = CACurrentMediaTime()
        var dares: Bool
        if let d = edgeDares[key], now < d.until { dares = d.dares }
        else {
            let tries = (edgeDares[key].map { now - $0.until < 30 ? $0.tries + 1 : 0 }) ?? 0
            dares = drop <= bodyHeight() * 1.5 || Double.random(in: 0..<1) < dareChance(drop: drop, tries: tries)
            edgeDares[key] = EdgeDare(key: key, until: now + (dares ? 6 : Double.random(in: 6...14)), dares: dares, tries: tries)
            NSLog("Arthur hop down here: drop %.1f heights, %@ (try %d)", Double(drop / max(1, bodyHeight())), dares ? "jumps" : "won't", tries)
        }
        guard dares else { return false }
        if itemState != nil { braveDropPending = drop > bodyHeight() * 1.5 }
        dropThroughY = ledge.y
        sittingUntil = nil
        startFalling(vx: dir * 70, vy: -280)
        return true
    }

    /// Strolling about, he peered over an edge and decided against it.
    private var peekUntil: CFTimeInterval = 0

    private var edgeFear = false
    private var nextEdgeFearCheck: CFTimeInterval = 0
    private func updateEdgeFear() {
        var near = false
        if stranded, case .resting = motion, let ledge, ledge.hasDropAtEnds, let feet = feetOnScreen() {
            let (lo, hi) = span(of: ledge)
            near = feet.x - lo < 50 || hi - feet.x < 50
        }
        if CACurrentMediaTime() < peekUntil, case .resting = motion { near = true }
        guard near != edgeFear else { return }
        edgeFear = near
        js("window.ArthurHost && ArthurHost.edgeFear && ArthurHost.edgeFear(\(near))")
    }

    private func setStranded(_ on: Bool, rescued: Bool = false) {
        guard stranded != on else { return }
        stranded = on
        js("window.ArthurHost && ArthurHost.stranded && ArthurHost.stranded(\(on), \(rescued))")
    }

    private func updateStamina(now: CFTimeInterval, dt: CGFloat) {
        switch motion {
        case .walking where fleeing: stamina -= 0.035 * dt
        case .resting: stamina += 0.05 * dt
        default: break
        }
        stamina = min(1, max(0, stamina))
        if !tired && stamina < tiredAt {
            tired = true
            nextBreather = now + Double.random(in: 1.5...3)
            js("window.ArthurHost && ArthurHost.tired && ArthurHost.tired(true)")
            if fleeing { js("window.ArthurHost && ArthurHost.walkRate && ArthurHost.walkRate(1.3)") }
        } else if tired && stamina > min(0.9, tiredAt + 0.35) {
            tired = false
            tiredAt = CGFloat.random(in: 0.15...0.35)
            js("window.ArthurHost && ArthurHost.tired && ArthurHost.tired(false)")
        }
    }

    /// Room above that edge for him to jump up onto it: his head (and the jump's
    /// clearance) must stay under the top of the screen, or he bonks it and falls
    /// straight back down, over and over.
    private func headroom(on l: Ledge, at x: CGFloat) -> Bool {
        let top = NSScreen.screens.first { $0.frame.minX <= x && x <= $0.frame.maxX }?.visibleFrame.maxY ?? .greatestFiniteMagnitude
        return l.y + bodyHeight() + 46 + 8 <= top
    }
    /// A jump that came down short of where he aimed: no more tries for a while.
    private var hopAimY: CGFloat?
    private var noHopsUntil: CFTimeInterval = 0

    /// A window edge to climb onto on the way up towards (x, y): the highest one he
    /// can reach from here that isn't above the target. nil if none.
    private func stepUp(towards target: NSPoint, from current: Ledge) -> (Ledge, CGFloat)? {
        guard let feet = feetOnScreen() else { return nil }
        let maxRise = panel.frame.height * 1.2       // desperate: higher than he'd normally try
        let reach = 420 * max(zoom, 0.5)
        let margin: CGFloat = 36
        return ledges().compactMap { l -> (Ledge, CGFloat)? in
            guard l.kind == .window, l.maxX - l.minX >= margin * 2 + 20 else { return nil }
            let rise = l.y - current.y
            guard rise > 30, rise <= maxRise, l.y <= target.y + 4 else { return nil }
            let x = min(max(target.x, l.minX + margin), l.maxX - margin)
            guard abs(x - feet.x) <= reach, headroom(on: l, at: x) else { return nil }
            return (l, x)
        }.max { a, b in a.0.y != b.0.y ? a.0.y < b.0.y : abs(a.1 - target.x) > abs(b.1 - target.x) }
    }

    /// Jump onto `ledge` at `landX` (his own jump: costs stamina).
    private func hop(to ledge: Ledge, landX: CGFloat) {
        guard let feet = feetOnScreen() else { return }
        let g = Self.gravity, clearance: CGFloat = 46
        let up = sqrt(2 * g * (ledge.y - feet.y + clearance))
        let flight = up / g + sqrt(2 * clearance / g)
        stamina -= 0.08
        excitedClimb = true                 // climbing after his things: higher than he'd dare otherwise
        if itemState != nil, climbBaseY == nil || CACurrentMediaTime() - climbBaseAt > 25 {
            climbBaseY = feet.y; climbBaseAt = CACurrentMediaTime()
        }
        hopping = true
        hopAimY = ledge.y
        sittingUntil = nil
        startFalling(vx: (landX - feet.x) / flight, vy: -up, hop: true)
    }
    // A stolen thing out on the desktop.
    private enum ItemState { case held, falling(vy: CGFloat), lying(Ledge), unreachable(Ledge) }
    private var itemPanel: ItemPanel?
    private var itemState: ItemState?
    private var nextFetchPlan: CFTimeInterval = 0
    // A peace offering he left out after a sulk: lie on the desktop until she
    // takes it (click), tries to hand it back (he won't have it), or a day passes.
    private enum GiftState { case falling(vy: CGFloat), lying, held(start: NSPoint, moved: Bool) }
    private var giftPanel: ItemPanel?
    private var giftState: GiftState?
    private var giftBorn: Date?
    /// Landing after she carried him (to say something about being put down).
    private var carried = false
    /// Where his feet were when she picked him up, and the most he's been lifted (in his own heights).
    private var dragStartY: CGFloat = 0
    private var dragMaxLift: CGFloat = 0
    private var dragStartedAt: CFTimeInterval = 0
    private var nextLiftReport: CFTimeInterval = 0
    /// How high above where he was picked up, in units of his own height.
    private func liftNow() -> CGFloat {
        guard let feet = feetOnScreen() else { return 0 }
        return max(0, feet.y - dragStartY) / max(1, panel.frame.height * 0.6)
    }
    /// In the air on a jump of his own (aimed, so no air drag).
    private var hopping = false
    /// Highest his feet got since he started falling (for a hard landing).
    private var fallPeakY: CGFloat = 0
    /// Hit a wall/ceiling so hard he'll be flat on the ground once he lands.
    private var splatOnLanding = false
    private static let dizzySpeed: CGFloat = 650     // pt/s into a wall → stars
    private static let splatSpeed: CGFloat = 1500    // pt/s into a wall → flat on the ground

    /// He hit a wall or the ceiling at `speed`.
    private func bonk(_ speed: CGFloat) {
        guard !hopping else { return }
        if speed >= Self.splatSpeed {
            splatOnLanding = true
            js("window.ArthurHost && ArthurHost.knock && ArthurHost.knock('dizzy', true)")
        } else if speed >= Self.dizzySpeed {
            js("window.ArthurHost && ArthurHost.knock && ArthurHost.knock('dizzy')")
        }
    }
    /// Sent away while up on a window: walk off once he's on the floor.
    private var leaveWhenGrounded = false
    private var pendingAwayUntil: Double?
    private var nextWanderAt: CFTimeInterval = CACurrentMediaTime() + 20
    private var lastPointerSent: CGPoint?
    private var lastPointerAt: CFTimeInterval = 0
    private var settledOnce = false

    /// Only the screenshot shortcuts (cmd-shift-3/4/5), nothing else she types.
    private var screenshotMonitor: Any?
    private var lastScreenshotKey: CFTimeInterval = 0
    /// New screenshots as Spotlight sees them (whether it's a screen capture, made just now;
    /// not what's in it). Works without accessibility, and for the Screenshot app too.
    private var screenshotQuery: NSMetadataQuery?
    private func watchScreenshotFiles() {
        let q = NSMetadataQuery()
        q.predicate = NSPredicate(format: "kMDItemIsScreenCapture == 1 AND kMDItemContentCreationDate > %@", Date() as NSDate)
        q.searchScopes = [NSMetadataQueryLocalComputerScope]
        NotificationCenter.default.addObserver(forName: .NSMetadataQueryDidUpdate, object: q, queue: .main) { [weak self] note in
            guard let self, let added = note.userInfo?[NSMetadataQueryUpdateAddedItemsKey] as? [Any], !added.isEmpty else { return }
            let now = CACurrentMediaTime()
            guard now - self.lastScreenshotKey > 8 else { return }    // the shortcut already told him
            self.lastScreenshotKey = now
            self.js("window.ArthurHost && ArthurHost.screenshot && ArthurHost.screenshot('full')")
        }
        q.start()
        screenshotQuery = q
    }

    private func watchScreenshotKeys() {
        NSLog("Arthur screenshot keys: accessibility %@", AXIsProcessTrusted() ? "granted" : "not granted")
        screenshotMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] e in
            guard let self else { return }
            let mods = e.modifierFlags.intersection([.command, .shift, .option, .control])
            guard mods.contains([.command, .shift]), !mods.contains(.option) else { return }
            let kind: String
            switch e.keyCode { case 20: kind = "full"; case 21: kind = "area"; case 23: kind = "tool"; default: return }
            let now = CACurrentMediaTime()
            guard now - self.lastScreenshotKey > 4 else { return }
            self.lastScreenshotKey = now
            self.js("window.ArthurHost && ArthurHost.screenshot && ArthurHost.screenshot('\(kind)')")
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        makePanel()
        makeStatusItem()
        registerHotKeys()
        watchScreenshotKeys()
        watchScreenshotFiles()
        loadCompanion()
        // Not visible (screen locked or asleep, sent away, covered): let the page idle.
        NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: panel, queue: .main) { [weak self] _ in
            guard let self else { return }
            let hidden = !self.panel.occlusionState.contains(.visible)
            self.js("window.ArthurHost && ArthurHost.occluded && ArthurHost.occluded(\(hidden))")
        }
        applyScale()
        applyLevel()
        applyClickThrough()
        if !prefs.hidden { panel.orderFrontRegardless() }
        // The first time each day she opens the computer (launch, wake, unlock),
        // he greets her for the time of day.
        let workspace = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didWakeNotification, NSWorkspace.screensDidWakeNotification, NSWorkspace.sessionDidBecomeActiveNotification] {
            workspace.addObserver(self, selector: #selector(computerOpened), name: name, object: nil)
        }
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(computerOpened), name: NSNotification.Name("com.apple.screenIsUnlocked"), object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(screensChanged),
            name: NSApplication.didChangeScreenParametersNotification, object: nil
        )
        ticker = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(ticker!, forMode: .common)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showCompanion()
        return true
    }

    // MARK: - Window

    private func makePanel() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.userContentController.add(WeakMessageHandler(self), name: "arthurHost")

        let contentFrame = NSRect(origin: .zero, size: Self.baseSize)
        let container = NSView(frame: contentFrame)

        let page = CompanionWebView(frame: container.bounds, configuration: configuration)
        page.onFileHover = { [weak self] on in self?.js("window.ArthurHost && ArthurHost.fileHover && ArthurHost.fileHover(\(on))") }
        page.onFilesDropped = { [weak self] urls in self?.filesGiven(urls) }
        webView = page
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.autoresizingMask = [.width, .height]
        if #available(macOS 12.0, *) {
            webView.underPageBackgroundColor = .clear
        }
        container.addSubview(webView)

        panel = CompanionPanel(
            contentRect: contentFrame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.title = "Arthur Desktop Companion"
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.contentView = container
        // Hovering over him must reach the page (rubbing his belly or hand, resting
        // on his cheek); without this only clicks and drags got through.
        panel.acceptsMouseMovedEvents = true
        // Start fully click-through; the hit test opens up only his own pixels.
        panel.ignoresMouseEvents = true
    }

    private var zoom: CGFloat { prefs.scale }

    private func applyScale() {
        let scale = prefs.scale
        let size = NSSize(width: Self.baseSize.width * scale, height: Self.baseSize.height * scale)
        // Zooming the page by the same factor keeps the picture identical,
        // just smaller. Page coordinates (hit rects, feet) are CSS px, so
        // screen points = CSS px × zoom.
        webView.pageZoom = scale
        let anchor = prefs.anchor ?? defaultAnchor(for: size)
        let frame = clamped(NSRect(x: anchor.x - size.width / 2, y: anchor.y, width: size.width, height: size.height))
        panel.setFrame(frame, display: true)
        settledOnce = false   // re-stand him on whatever is under his feet
    }

    private func defaultAnchor(for size: NSSize) -> NSPoint {
        let visible = NSScreen.main?.visibleFrame ?? .zero
        return NSPoint(x: visible.maxX - size.width / 2 - 24, y: visible.minY)
    }

    /// Keep enough of him on some screen that he can never get lost off-edge.
    private func clamped(_ frame: NSRect) -> NSRect {
        let screens = NSScreen.screens.map(\.visibleFrame)
        if screens.contains(where: { $0.intersection(frame).width > frame.width * 0.4 && $0.intersection(frame).height > frame.height * 0.3 }) {
            return frame
        }
        let visible = NSScreen.main?.visibleFrame ?? frame
        var f = frame
        f.origin.x = min(max(f.minX, visible.minX - f.width * 0.3), visible.maxX - f.width * 0.7)
        f.origin.y = min(max(f.minY, visible.minY - f.height * 0.3), visible.maxY - f.height)
        return f
    }

    private func rememberPosition() {
        let f = panel.frame
        prefs.anchor = NSPoint(x: f.midX, y: f.minY)
    }

    @objc private func screensChanged() {
        applyScale()
    }

    private func applyLevel() {
        panel.level = prefs.alwaysOnTop ? .floating : .normal
    }

    private func applyClickThrough() {
        panel.alphaValue = prefs.opacity
        statusItem?.button?.appearsDisabled = prefs.clickThrough
        if prefs.clickThrough { panel.ignoresMouseEvents = true }
    }

    // MARK: - Geometry helpers

    /// His feet in screen coordinates, or nil until the page has reported them.
    /// How tall he actually is on screen (feet to the top of his hair), not the panel.
    private func bodyHeight() -> CGFloat {
        guard let feet = feetOnScreen(), let top = screenRects().map(\.maxY).max(), top > feet.y + 20 else { return panel.frame.height * 0.45 }
        return top - feet.y
    }

    private func feetOnScreen(frame: NSRect? = nil) -> NSPoint? {
        guard let feet = feetCSS else { return nil }
        let f = frame ?? panel.frame
        return NSPoint(x: f.minX + feet.x * zoom, y: f.maxY - feet.y * zoom)
    }

    private func screenRects() -> [CGRect] {
        hitRects.map { r in
            let f = panel.frame
            return CGRect(x: f.minX + r.minX * zoom, y: f.maxY - r.maxY * zoom, width: r.width * zoom, height: r.height * zoom)
        }
    }

    private func isOverArthur(_ point: NSPoint) -> Bool {
        screenRects().contains { $0.insetBy(dx: -2, dy: -2).contains(point) }
    }

    /// Screen bottoms, the Dock's top, and the uncovered parts of ordinary window tops.
    private func ledges() -> [Ledge] {
        var result: [Ledge] = []
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        let me = Int(ProcessInfo.processInfo.processIdentifier)
        // A full-screen app hides the Dock, but visibleFrame still leaves room for it.
        let fullScreenRects: [CGRect] = info.compactMap { w in
            guard (w[kCGWindowLayer as String] as? Int) == 0,
                  (w[kCGWindowOwnerPID as String] as? Int) != me,
                  let b = w[kCGWindowBounds as String] as? [String: CGFloat],
                  let x = b["X"], let y = b["Y"], let width = b["Width"], let height = b["Height"]
            else { return nil }
            return CGRect(x: x, y: primaryHeight - y - height, width: width, height: height)
        }
        // The Dock draws in a window at the Dock level. In a full-screen app (even one
        // that keeps the menu bar showing) that window is gone while visibleFrame still
        // leaves room for it, and he sat on thin air.
        let dockLevel = Int(CGWindowLevelForKey(.dockWindow))
        let everything = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
        let dockShowing = everything.contains {
            ($0[kCGWindowOwnerName as String] as? String) == "Dock" && ($0[kCGWindowLayer as String] as? Int) == dockLevel
        }
        for s in NSScreen.screens {
            // The real bottom of the glass, not the visible-frame line: with the Dock at
            // the bottom that line runs the full width, and beside the Dock he sat on air.
            result.append(Ledge(y: s.frame.minY, minX: s.frame.minX, maxX: s.frame.maxX, kind: .floor))
            let fullScreen = fullScreenRects.contains { $0.insetBy(dx: 2, dy: 2).contains(s.frame.insetBy(dx: 4, dy: 4)) }
            if !fullScreen, dockShowing, let dock = dockLedge(on: s) { result.append(dock) }
        }
        guard prefs.climbsWindows, primaryHeight > 0 else { return result }
        let visibleTops = NSScreen.screens.map(\.visibleFrame)
        // Front to back, as the window server lists them. Each window's top edge is only
        // a ledge where no window in front of it covers that line.
        var inFront: [CGRect] = []
        for w in info {
            guard (w[kCGWindowLayer as String] as? Int) == 0,
                  (w[kCGWindowOwnerPID as String] as? Int) != me,
                  (w[kCGWindowAlpha as String] as? Double ?? 1) > 0.05,
                  let b = w[kCGWindowBounds as String] as? [String: CGFloat],
                  let x = b["X"], let y = b["Y"], let width = b["Width"], let height = b["Height"],
                  width >= 160, height >= 80
            else { continue }
            let rect = CGRect(x: x, y: primaryHeight - y - height, width: width, height: height)
            defer { inFront.append(rect) }
            let top = rect.maxY
            // Windows tucked under the menu bar (full-height or full-screen) have no ledge to stand on.
            guard visibleTops.contains(where: { top < $0.maxY - 4 && top > $0.minY + 40 && x + width > $0.minX && x < $0.maxX }) else { continue }
            var spans: [(CGFloat, CGFloat)] = [(rect.minX, rect.maxX)]
            for cover in inFront where cover.minY < top - 2 && cover.maxY > top - 2 {
                spans = spans.flatMap { span -> [(CGFloat, CGFloat)] in
                    let (a, b) = span
                    guard cover.maxX > a, cover.minX < b else { return [span] }
                    return [(a, cover.minX), (cover.maxX, b)].filter { $0.1 - $0.0 > 0 }
                }
            }
            for (a, b) in spans where b - a >= 80 {
                result.append(Ledge(y: top, minX: a, maxX: b, kind: .window, windowNumber: w[kCGWindowNumber as String] as? Int))
            }
        }
        return result
    }

    private var dockCache: (at: CFTimeInterval, span: (CGFloat, CGFloat)?)?

    /// The top of the Dock when it sits along the bottom of `screen`.
    private func dockLedge(on screen: NSScreen) -> Ledge? {
        let height = screen.visibleFrame.minY - screen.frame.minY
        guard height > 8 else { return nil }   // Dock hidden, or on a side
        let now = CACurrentMediaTime()
        if dockCache == nil || now - dockCache!.at > 3 {
            dockCache = (now, accessibleDockSpan() ?? estimatedDockSpan(screen: screen, height: height))
        }
        guard let (a, b) = dockCache?.span, b > screen.frame.minX, a < screen.frame.maxX else { return nil }
        return Ledge(y: screen.visibleFrame.minY, minX: max(a, screen.frame.minX), maxX: min(b, screen.frame.maxX), kind: .dock)
    }

    /// Exact, but only when the app has been allowed Accessibility access.
    private func accessibleDockSpan() -> (CGFloat, CGFloat)? {
        guard AXIsProcessTrusted(),
              let dock = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first
        else { return nil }
        let app = AXUIElementCreateApplication(dock.processIdentifier)
        var kids: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXChildrenAttribute as CFString, &kids) == .success,
              let list = (kids as? [AXUIElement])?.first
        else { return nil }
        var p: CFTypeRef?, sz: CFTypeRef?
        AXUIElementCopyAttributeValue(list, kAXPositionAttribute as CFString, &p)
        AXUIElementCopyAttributeValue(list, kAXSizeAttribute as CFString, &sz)
        var point = CGPoint.zero, size = CGSize.zero
        guard let p, let sz, AXValueGetValue(p as! AXValue, .cgPoint, &point),
              AXValueGetValue(sz as! AXValue, .cgSize, &size), size.width > 40 else { return nil }
        return (point.x, point.x + size.width)
    }

    /// Without Accessibility access: count the Dock's icons and lay them out the way
    /// the Dock does, centred on the screen. Close, not exact.
    private func estimatedDockSpan(screen: NSScreen, height: CGFloat) -> (CGFloat, CGFloat)? {
        let dock = UserDefaults(suiteName: "com.apple.dock")
        let tile = CGFloat(dock?.double(forKey: "tilesize") ?? 0).nonZero ?? max(height - 16, 24)
        func bundleIDs(_ key: String) -> [String] {
            (dock?.array(forKey: key) as? [[String: Any]] ?? []).compactMap {
                (($0["tile-data"] as? [String: Any])?["bundle-identifier"] as? String)
            }
        }
        let pinned = Set(bundleIDs("persistent-apps"))
        let others = (dock?.array(forKey: "persistent-others") as? [Any])?.count ?? 0
        let showRecents = dock?.object(forKey: "show-recents") as? Bool ?? true
        let running = Set(NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
            .compactMap(\.bundleIdentifier))
            .subtracting(pinned).subtracting(["com.apple.finder"])
        var recent = 0
        if showRecents {
            recent = Set(bundleIDs("recent-apps")).subtracting(pinned).subtracting(running).count
        }
        let icons = 1 + pinned.count + running.count + recent + others + 1   // Finder … Trash
        let separators = 1 + ((running.count + recent) > 0 ? 1 : 0)
        let width = CGFloat(icons) * (tile + 5) + CGFloat(separators) * tile * 0.45 + 16
        let mid = screen.frame.midX
        return (mid - width / 2, mid + width / 2)
    }

    /// The highest ledge at or below `y` that is under horizontal position `x`.
    /// The run of ledges at the same height that touch this one, end to end.
    private func span(of ledge: Ledge) -> (CGFloat, CGFloat) {
        let same = ledges().filter { abs($0.y - ledge.y) < 3 }.sorted { $0.minX < $1.minX }
        var lo = ledge.minX, hi = ledge.maxX, grew = true
        while grew {
            grew = false
            for l in same where l.maxX >= lo - 14 && l.minX <= hi + 14 && (l.minX < lo || l.maxX > hi) {
                lo = min(lo, l.minX); hi = max(hi, l.maxX); grew = true
            }
        }
        return (lo, hi)
    }

    private func ledge(below y: CGFloat, at x: CGFloat) -> Ledge? {
        ledges()
            .filter { $0.y <= y + 1 && x >= $0.minX + 6 && x <= $0.maxX - 6 }
            .max { $0.y < $1.y }
    }

    private func moveFeet(to point: NSPoint) {
        guard let feet = feetCSS else { return }
        let size = panel.frame.size
        panel.setFrameOrigin(NSPoint(x: point.x - feet.x * zoom, y: point.y - (size.height - feet.y * zoom)))
    }

    // MARK: - Page messages

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "hit":
            if let raw = body["rects"] as? [[Double]] {
                hitRects = raw.compactMap { $0.count == 4 ? CGRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) : nil }
            }
            if let f = body["feet"] as? [Double], f.count == 2 { feetCSS = CGPoint(x: f[0], y: f[1]) }
            pageCanWander = body["canWander"] as? Bool ?? false
            pageCanSit = body["canSit"] as? Bool ?? false
            pageSeated = body["seated"] as? Bool ?? false
            if !settledOnce, feetCSS != nil { settledOnce = true; startFalling() }
        case "drag-begin":
            let mouse = NSEvent.mouseLocation
            dragSamples = [(CACurrentMediaTime(), mouse)]
            carried = true
            supportLost = false
            setFloating(false)
            cornerSeekUntil = nil
            if stranded { rescuedPending = true }
            excitedClimb = false
            dragStartY = feetOnScreen()?.y ?? 0
            dragStartX = feetOnScreen()?.x ?? 0
            dragStartLedgeY = ledge?.y
            dragMaxLift = 0
            dragStartedAt = CACurrentMediaTime()
            dragTrail = [(CACurrentMediaTime(), mouse)]
            dragTurn = 0
            dragMotionSaid = [:]
            // Held for a moment and properly off the ground: he has something to say.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                guard let self, case .dragging = self.motion, self.liftNow() >= 0.6 else { return }
                self.js("window.ArthurHost && ArthurHost.pickedUp && ArthurHost.pickedUp()")
            }
            hopping = false
            hopAimY = nil
            splatOnLanding = false
            leaveWhenGrounded = false
            pendingAwayUntil = nil
            stopWalking(tellPage: false)
            sittingUntil = nil
            motion = .dragging(offset: NSPoint(x: mouse.x - panel.frame.minX, y: mouse.y - panel.frame.minY))
            panel.ignoresMouseEvents = false
        case "log":
            NSLog("Arthur page: %@", (body["text"] as? String) ?? "")
        case "leave":
            sendAway(untilMs: body["until"] as? Double)
        case "kv":
            if let json = body["json"] as? String, json.count < 16000 { prefs.pageKV = json }
        case "go-corner":
            goToCorner()
        case "pockets":
            if let json = body["json"] as? String, json.count < 8000 { prefs.pockets = json }
        case "gift-drop":
            if let icon = body["icon"] as? String { dropGift(icon: icon) }
        case "steal-start":
            if let icon = body["icon"] as? String { beginSteal(icon: icon) }
        case "chase-pause":
            // Gone to bed with his things still out: no chasing, fetching or grabbing till he's up.
            chasePaused = (body["on"] as? Bool) == true
            if chasePaused, case .walking = motion, fleeing { stopWalking() }
        case "chase-refuse":
            // Led on once too often: he won't go after it; she can bring it to him.
            chaseRefused = (body["on"] as? Bool) == true
            if chaseRefused, case .walking = motion, fleeing { stopWalking() }
            if chaseRefused, stranded { setStranded(false) }
        case "dare-bias":
            dareBias = max(-0.5, min(0.5, body["value"] as? Double ?? 0))
            dareBiasUntil = CACurrentMediaTime() + max(0, body["minutes"] as? Double ?? 0) * 60
            edgeDares.removeAll()          // he thinks again about every edge
        case "pat-count":
            if let n = body["n"] as? Int { prefs.patCount = max(0, n) }
        case "touch-count":
            if let n = body["n"] as? Int { prefs.touchCount = max(0, n) }
        case "flee":
            flee(direction: (body["direction"] as? Double ?? 1) < 0 ? -1 : 1)
        case "letter-read":
            if let id = body["id"] as? String, id.range(of: "^[0-9a-f]{12}$", options: .regularExpression) != nil {
                prefs.letterRead = id
            }
        case "outfit":
            if let mode = body["mode"] as? String { wear(mode, untilMs: body["until"] as? Double) }
        case "drag-end":
            if case .dragging = motion { releaseDrag() }
        default:
            break
        }
    }

    /// She dropped files on him: hand the page their names, nothing else.
    private func filesGiven(_ urls: [URL]) {
        let first = urls[0]
        let payload: [Any] = [first.lastPathComponent, first.hasDirectoryPath, urls.count]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        js("window.ArthurHost && ArthurHost.fileGiven && ArthurHost.fileGiven(...\(json))")
    }

    private func js(_ source: String, _ completion: ((Any?) -> Void)? = nil) {
        webView.evaluateJavaScript(source) { value, _ in completion?(value) }
    }

    // MARK: - Movement

    /// The floor went from under him (a window closed, moved or got covered),
    /// not her doing: he opens his umbrella and drifts down.
    private var supportLost = false
    private var floating = false
    private func setFloating(_ on: Bool) {
        guard on != floating else { return }
        floating = on
        js("window.ArthurHost && ArthurHost.floatDown && ArthurHost.floatDown(\(on))")
    }

    private func startFalling(vx: CGFloat = 0, vy: CGFloat = 0, hop: Bool = false) {
        supportLost = false
        guard let feet = feetOnScreen() else { return }
        sittingUntil = nil
        // Make sure there is a screen under him to land on at all.
        let spans = NSScreen.screens.map(\.visibleFrame)
        if !spans.contains(where: { feet.x >= $0.minX + 20 && feet.x <= $0.maxX - 20 }),
           let nearest = spans.min(by: { abs($0.midX - feet.x) < abs($1.midX - feet.x) }) {
            let x = min(max(feet.x, nearest.minX + 40), nearest.maxX - 40)
            panel.setFrameOrigin(NSPoint(x: panel.frame.minX + (x - feet.x), y: panel.frame.minY))
        }
        ledge = nil
        fallPeakY = feet.y
        if hop {
            js("window.ArthurHost && ArthurHost.hop && ArthurHost.hop(\(vx < 0 ? -1 : 1))")
        } else {
            js("window.ArthurHost && ArthurHost.fall()")
        }
        motion = .falling(vx: vx, vy: vy)
    }

    // MARK: - A stolen thing

    private var chasePaused = false
    /// Catching up with her while she still has it: he grabs it back.
    private var stealStartedAt: CFTimeInterval = 0
    private var snatchReachSince: CFTimeInterval?
    private var snatchArmed = false            // she's had it away from him at least once
    private func trySnatch(mouse: NSPoint, now: CFTimeInterval) -> Bool {
        guard let feet = feetOnScreen() else { return false }
        switch motion { case .resting, .walking: break; default: snatchReachSince = nil; return false }
        let h = bodyHeight()
        let reachX = h * 0.75
        let within = abs(mouse.x - feet.x) < reachX && mouse.y > feet.y - 10 && mouse.y < feet.y + h * 1.05
        if !within {
            snatchReachSince = nil
            if abs(mouse.x - feet.x) > reachX * 1.6 || mouse.y > feet.y + h * 1.6 { snatchArmed = true }
            return false
        }
        guard snatchArmed, now - stealStartedAt > 1.2 else { return false }
        if snatchReachSince == nil { snatchReachSince = now }
        // Hold it there a moment (giving it back means letting go on him).
        guard now - snatchReachSince! > 0.6 else { return false }
        snatchReachSince = nil
        finishItem("snatched")
        return true
    }

    private func beginSteal(icon: String) {
        itemPanel?.orderOut(nil)
        let item = ItemPanel(icon: icon, size: 40 + 34 * zoom)
        item.onGrab = { [weak self] in self?.grabItem() }
        item.center(at: NSEvent.mouseLocation)
        item.orderFrontRegardless()
        itemPanel = item
        itemState = .held
        chasePaused = false
        chaseRefused = false
        braveDropPending = false
        braveLandedAt = nil
        climbedAt = nil
        climbBaseY = nil
        baitCount = 0
        stealStartedAt = CACurrentMediaTime()
        snatchReachSince = nil
        snatchArmed = false
        sittingUntil = nil
        if pageSeated { sit(false) }
    }

    // MARK: - A peace offering

    private func dropGift(icon: String) {
        giftPanel?.orderOut(nil)
        let gift = ItemPanel(icon: icon, size: 40 + 34 * zoom)
        gift.onGrab = { [weak self] in
            guard let self, self.giftPanel != nil else { return }
            self.giftState = .held(start: NSEvent.mouseLocation, moved: false)
        }
        // Left near him, a little to one side, falling onto whatever is below.
        let feet = feetOnScreen() ?? NSPoint(x: panel.frame.midX, y: panel.frame.minY)
        let side: CGFloat = Bool.random() ? 1 : -1
        gift.center(at: NSPoint(x: feet.x + side * CGFloat.random(in: 110...200) * max(zoom, 0.5), y: feet.y + panel.frame.height * 0.6))
        gift.ignoresMouseEvents = true
        gift.orderFrontRegardless()
        giftPanel = gift
        giftState = .falling(vy: 0)
        giftBorn = Date()
    }

    private func clearGift(_ how: String?) {
        giftPanel?.orderOut(nil)
        giftPanel = nil
        giftState = nil
        giftBorn = nil
        if let how { js("window.ArthurHost && ArthurHost.giftDone && ArthurHost.giftDone('\(how)')") }
    }

    private func updateGift(dt: CGFloat) {
        guard let gift = giftPanel, let state = giftState else { return }
        // Untouched for a day (or past midnight): it quietly goes.
        if let born = giftBorn, Date().timeIntervalSince(born) > 20 * 3600 || !Calendar.current.isDate(born, inSameDayAs: Date()) {
            clearGift(nil); return
        }
        let mouse = NSEvent.mouseLocation
        switch state {
        case .falling(var vy):
            vy += Self.gravity * dt
            let foot = gift.foot
            let nextY = foot.y - vy * dt
            if let target = ledge(below: foot.y, at: foot.x), nextY <= target.y {
                gift.rest(foot: NSPoint(x: foot.x, y: target.y))
                giftState = .lying
                gift.ignoresMouseEvents = false
            } else if nextY < (NSScreen.screens.map(\.frame.minY).min() ?? 0) - 100 {
                clearGift(nil)
            } else {
                gift.rest(foot: NSPoint(x: foot.x, y: nextY))
                giftState = .falling(vy: vy)
            }
        case .lying:
            if ledges().first(where: { $0.minX <= gift.foot.x && gift.foot.x <= $0.maxX && abs($0.y - gift.foot.y) < 2 }) == nil {
                gift.ignoresMouseEvents = true
                giftState = .falling(vy: 0)
            }
        case .held(let start, var moved):
            if hypot(mouse.x - start.x, mouse.y - start.y) > 6 { moved = true }
            if NSEvent.pressedMouseButtons & 1 == 0 {
                if !moved {
                    clearGift("accepted")                  // a click: she takes it
                } else if isOverArthur(mouse) || panel.frame.insetBy(dx: panel.frame.width * 0.2, dy: panel.frame.height * 0.15).contains(mouse) {
                    // Trying to give it back: he won't take it, and pushes it back out.
                    js("window.ArthurHost && ArthurHost.giftRefused && ArthurHost.giftRefused()")
                    let feet = feetOnScreen() ?? mouse
                    gift.center(at: NSPoint(x: feet.x + (mouse.x >= feet.x ? 1 : -1) * 150 * max(zoom, 0.5), y: mouse.y))
                    gift.ignoresMouseEvents = true
                    giftState = .falling(vy: -300)
                } else {
                    gift.ignoresMouseEvents = true
                    giftState = .falling(vy: 0)
                }
            } else {
                if moved { gift.center(at: NSPoint(x: mouse.x, y: mouse.y + 6)) }
                giftState = .held(start: start, moved: moved)
            }
        }
    }

    /// She picks the dropped thing up again.
    private func grabItem() {
        guard itemPanel != nil else { return }
        itemState = .held
        itemPanel?.ignoresMouseEvents = true
    }

    private func finishItem(_ how: String) {
        itemPanel?.orderOut(nil)
        itemPanel = nil
        itemState = nil
        fleeing = false
        chaseRefused = false
        braveLandedAt = nil
        climbedAt = nil
        climbBaseY = nil
        js("window.ArthurHost && ArthurHost.itemBack && ArthurHost.itemBack('\(how)')")
    }

    private func updateItem(now: CFTimeInterval, dt: CGFloat) {
        guard let item = itemPanel, let state = itemState else { return }
        let mouse = NSEvent.mouseLocation
        switch state {
        case .held:
            item.center(at: NSPoint(x: mouse.x, y: mouse.y + 6))
            if NSEvent.pressedMouseButtons & 1 == 0 {
                // Let go: on him = given back; anywhere else = dropped there.
                if isOverArthur(mouse) || panel.frame.insetBy(dx: panel.frame.width * 0.2, dy: panel.frame.height * 0.15).contains(mouse) {
                    finishItem("returned")
                } else {
                    itemState = .falling(vy: 0)
                    stopWalking()
                    js("window.ArthurHost && ArthurHost.itemDropped && ArthurHost.itemDropped()")
                }
            } else {
                checkBaited(now: now, at: item.foot)
                if !chasePaused, !chaseRefused, !trySnatch(mouse: mouse, now: now) { chase(x: mouse.x) }
            }
        case .falling(var vy):
            vy += Self.gravity * dt
            let foot = item.foot
            let nextY = foot.y - vy * dt
            if let target = ledge(below: foot.y, at: foot.x), nextY <= target.y {
                item.rest(foot: NSPoint(x: foot.x, y: target.y))
                itemState = .lying(target)
                item.ignoresMouseEvents = false      // she can pick it up again
                nextFetchPlan = now + 0.6
            } else if nextY < (NSScreen.screens.map(\.frame.minY).min() ?? 0) - 100 {
                finishItem("fetched")                // fell off every screen: he finds it anyway
            } else {
                item.rest(foot: NSPoint(x: foot.x, y: nextY))
                itemState = .falling(vy: vy)
            }
        case .lying(let spot):
            // The window it landed on moved or closed: it falls again.
            if ledges().first(where: { abs($0.y - spot.y) < 2 && $0.minX <= item.foot.x && item.foot.x <= $0.maxX }) == nil {
                itemState = .falling(vy: 0); item.ignoresMouseEvents = true; break
            }
            if !chasePaused, !chaseRefused, now >= nextFetchPlan { nextFetchPlan = now + 0.6; planFetch(item: item, spot: spot) }
        case .unreachable(let spot):
            if ledges().first(where: { abs($0.y - spot.y) < 2 && $0.minX <= item.foot.x && item.foot.x <= $0.maxX }) == nil {
                itemState = .falling(vy: 0); item.ignoresMouseEvents = true
            }
        }
    }

    /// Soon after a brave drop, his things go back up above him: that's being led on.
    private func checkBaited(now: CFTimeInterval, at thing: NSPoint) {
        if let t = braveLandedAt, now - t > 15 { braveLandedAt = nil }
        if let t = climbedAt, now - t > 15 { climbedAt = nil }
        guard braveLandedAt != nil || climbedAt != nil, let feet = feetOnScreen() else { return }
        let up = braveLandedAt != nil && thing.y - feet.y > bodyHeight() * 1.5     // jumped down; it went back up
        let down = climbedAt != nil && feet.y - thing.y > bodyHeight() * 1.5       // climbed up; it went back down
        guard up || down else { return }
        braveLandedAt = nil
        climbedAt = nil
        climbBaseY = nil
        baitCount += 1
        NSLog("Arthur was led on (%d)", baitCount)
        js("window.ArthurHost && ArthurHost.baited && ArthurHost.baited(\(baitCount), '\(up ? "up" : "down")')")
    }

    /// While she runs off with it: after the mouse along whatever he's standing on.
    private func chase(x: CGFloat) {
        guard let ledge, let feet = feetOnScreen() else { return }
        switch motion { case .resting, .walking: break; default: return }
        let now = CACurrentMediaTime()
        // Worn out: every so often he stops to catch his breath.
        if tired {
            if now < catchBreathUntil { if case .walking = motion { stopWalking() }; return }
            if now >= nextBreather {
                catchBreathUntil = now + Double.random(in: 1.5...3.2)
                nextBreather = catchBreathUntil + Double.random(in: 2.5...5)
                if case .walking = motion { stopWalking() }
                return
            }
        }
        // The mouse is up above him: climb the nearest window he can, step by step.
        let mouse = NSEvent.mouseLocation
        if !tired, case .resting = motion, now >= nextChaseHop, now >= noHopsUntil, mouse.y - feet.y > panel.frame.height * 0.5,
           let (step, landX) = stepUp(towards: mouse, from: ledge) {
            nextChaseHop = now + 1.2
            hop(to: step, landX: landX)
            return
        }
        let lo = ledge.minX + 20, hi = ledge.maxX - 20
        var target = min(max(x, lo), hi)
        // She's gone below him, somewhere over his own road: walk above her and hop down there.
        if ledge.hasDropAtEnds, mouse.y < feet.y - 60, x > lo + 10, x < hi - 10 {
            if abs(x - feet.x) < 60, case .resting = motion, hopDownHere(towards: x > feet.x ? 1 : -1) { return }
        }
        // She's gone below him: down he goes, off the end nearest her.
        if ledge.hasDropAtEnds, mouse.y < feet.y - 60, !(x > lo + 10 && x < hi - 10) {
            // Down after her. Windows side by side at the same height are one
            // long edge to him; of its two ends he takes one he dares drop from
            // (one level at a time if he must), nearer her if both will do.
            let (lo2, hi2) = span(of: ledge)
            let ends = [lo2 - 30, hi2 + 30].filter { !tooHighToDrop(ledge, at: $0) }
            if let end = ends.min(by: { abs($0 - x) < abs($1 - x) }) {
                if stranded { setStranded(false) }  // a way down after all
                target = end < feet.x ? lo2 - 40 : hi2 + 40
            } else if case .resting = motion {
                setStranded(true)                  // both ends too high: he won't
                return
            }
        }
        if abs(target - feet.x) < 26 {
            if case .walking = motion { stopWalking() }
            return
        }
        let dir: CGFloat = target > feet.x ? 1 : -1
        if case .walking(_, let d) = motion, d == dir {
            motion = .walking(targetX: target, direction: dir)
            fleeing = true
            return
        }
        js("window.ArthurHost ? ArthurHost.walk(\(dir > 0 ? 1 : -1)) : false") { [weak self] ok in
            guard let self, (ok as? Bool) == true else { return }
            self.fleeing = true
            self.motion = .walking(targetX: target, direction: dir)
        }
    }

    /// It's lying somewhere: go and get it, if he can.
    private func planFetch(item: ItemPanel, spot: Ledge) {
        guard case .resting = motion, let ledge, let feet = feetOnScreen() else { return }
        let itemX = item.foot.x
        if abs(ledge.y - spot.y) < 3 && ledge.minX <= itemX && itemX <= ledge.maxX {
            // Same surface: walk over and pick it up.
            if abs(itemX - feet.x) < 28 { finishItem("fetched"); return }
            let dir: CGFloat = itemX > feet.x ? 1 : -1
            js("window.ArthurHost ? ArthurHost.walk(\(dir > 0 ? 1 : -1)) : false") { [weak self] ok in
                guard let self, (ok as? Bool) == true, case .resting = self.motion else { return }
                self.fleeing = true
                self.motion = .walking(targetX: itemX, direction: dir)
            }
        } else if spot.y < ledge.y - 3, ledge.hasDropAtEnds, ledge.minX + 20 < itemX, itemX < ledge.maxX - 20,
                  abs(itemX - feet.x) > 40 || hopDownHere(towards: itemX > feet.x ? 1 : -1) {
            // It's below him, under his own edge: walk above it (then hop down, above).
            if abs(itemX - feet.x) <= 40 { return }
            let dir: CGFloat = itemX > feet.x ? 1 : -1
            js("window.ArthurHost ? ArthurHost.walk(\(dir > 0 ? 1 : -1)) : false") { [weak self] ok in
                guard let self, (ok as? Bool) == true, case .resting = self.motion else { return }
                self.fleeing = true
                self.motion = .walking(targetX: itemX, direction: dir)
            }
        } else if spot.y < ledge.y - 3 {
            // It's below him: head for the nearer end of what he's on and drop off it.
            var dir: CGFloat
            if itemX < ledge.minX { dir = -1 } else if itemX > ledge.maxX { dir = 1 } else { dir = (feet.x - ledge.minX) < (ledge.maxX - feet.x) ? -1 : 1 }
            if !ledge.hasDropAtEnds { return }
            if tooHighToDrop(ledge, at: dir < 0 ? ledge.minX - 30 : ledge.maxX + 30) {
                if tooHighToDrop(ledge, at: dir < 0 ? ledge.maxX + 30 : ledge.minX - 30) {
                    setStranded(true)
                    return
                }
                dir = -dir                                   // the other end, then
            }
            if stranded { setStranded(false) }               // a way down after all
            let target = dir < 0 ? ledge.minX - 60 : ledge.maxX + 60
            js("window.ArthurHost ? ArthurHost.walk(\(dir > 0 ? 1 : -1)) : false") { [weak self] ok in
                guard let self, (ok as? Bool) == true, case .resting = self.motion else { return }
                self.fleeing = true
                self.motion = .walking(targetX: target, direction: dir)
            }
        } else {
            // It's above him: jump up if he can, otherwise complain.
            let rise = spot.y - ledge.y
            let landX = min(max(itemX, spot.minX + 30), spot.maxX - 30)
            if tired {
                return                                    // get his breath back first
            } else if CACurrentMediaTime() < noHopsUntil {
                return                                    // just fell short: not again yet
            } else if rise <= panel.frame.height * 1.2, abs(landX - feet.x) <= 420 * max(zoom, 0.5), headroom(on: spot, at: landX) {
                hop(to: spot, landX: landX)
            } else if let (step, stepX) = stepUp(towards: NSPoint(x: itemX, y: spot.y), from: ledge) {
                hop(to: step, landX: stepX)               // one window nearer
            } else if abs(itemX - feet.x) > 40 && ledge.minX + 20 < itemX && itemX < ledge.maxX - 20 {
                // Get underneath it first.
                let dir: CGFloat = itemX > feet.x ? 1 : -1
                js("window.ArthurHost ? ArthurHost.walk(\(dir > 0 ? 1 : -1)) : false") { [weak self] ok in
                    guard let self, (ok as? Bool) == true, case .resting = self.motion else { return }
                    self.fleeing = true
                    self.motion = .walking(targetX: itemX, direction: dir)
                }
            } else {
                itemState = .unreachable(spot)
                js("window.ArthurHost && ArthurHost.itemUnreachable && ArthurHost.itemUnreachable()")
            }
        }
    }

    /// She touched him somewhere he isn't used to yet: he hurries off a little way.
    private func flee(direction: CGFloat) {
        guard case .resting = motion, let ledge, let feet = feetOnScreen() else { return }
        let reach = CGFloat.random(in: 180...320) * max(zoom, 0.5)
        let lo = ledge.minX + panel.frame.width * 0.25, hi = ledge.maxX - panel.frame.width * 0.25
        var dir = direction
        if (dir > 0 && feet.x + reach > hi) || (dir < 0 && feet.x - reach < lo) { dir = -dir }
        let target = min(max(feet.x + dir * reach, lo), hi)
        guard abs(target - feet.x) > 40 else { return }
        sittingUntil = nil
        js("window.ArthurHost ? ArthurHost.walk(\(dir > 0 ? 1 : -1)) : false") { [weak self] ok in
            guard let self, (ok as? Bool) == true, case .resting = self.motion else { return }
            self.fleeing = true
            self.motion = .walking(targetX: target, direction: dir)
        }
    }

    // How she's moving him about while she holds him: a stroll, a shake, a
    // spin, or dragging him along the floor. Told to the page as it happens.
    private var dragTrail: [(t: CFTimeInterval, p: NSPoint)] = []
    private var nextDragMotionRead: CFTimeInterval = 0
    private var dragTurn: CGFloat = 0
    private var dragMotionSaid: [String: CFTimeInterval] = [:]
    private var dragStartX: CGFloat = 0
    private var dragStartLedgeY: CGFloat?
    private func readDragMotion(now: CFTimeInterval, lift: CGFloat) {
        dragTrail.removeAll { now - $0.t > 3 }
        guard dragTrail.count > 6 else { return }
        // Velocities between successive samples about 50 ms apart.
        var vels: [(t: CFTimeInterval, v: CGVector)] = []
        var prev = dragTrail[0]
        for s in dragTrail.dropFirst() where s.t - prev.t >= 0.05 {
            let dt = CGFloat(s.t - prev.t)
            vels.append((s.t, CGVector(dx: (s.p.x - prev.p.x) / dt, dy: (s.p.y - prev.p.y) / dt)))
            prev = s
        }
        guard vels.count > 3 else { return }
        let recent = vels.filter { now - $0.t < 1.5 }
        // Side to side, hard: reversals of fast horizontal motion.
        var reversals = 0, lastSign = 0
        for v in recent where abs(v.v.dx) > 500 {
            let sign = v.v.dx > 0 ? 1 : -1
            if lastSign != 0 && sign != lastSign { reversals += 1 }
            lastSign = sign
        }
        // Round and round: total turning of the direction of travel.
        if vels.count >= 2 {
            let a = vels[vels.count - 2].v, b = vels[vels.count - 1].v
            if hypot(a.dx, a.dy) > 250 && hypot(b.dx, b.dy) > 250 {
                var d = atan2(b.dy, b.dx) - atan2(a.dy, a.dx)
                while d > .pi { d -= 2 * .pi }
                while d < -.pi { d += 2 * .pi }
                dragTurn += d
            } else { dragTurn *= 0.9 }
        }
        let avgX = recent.isEmpty ? 0 : recent.map { abs($0.v.dx) }.reduce(0, +) / CGFloat(recent.count)
        let avgY = recent.isEmpty ? 0 : recent.map { abs($0.v.dy) }.reduce(0, +) / CGFloat(recent.count)
        var kind: String?
        if abs(dragTurn) > 2 * .pi { kind = "spin"; dragTurn = 0 }
        else if reversals >= 3 { kind = "shake" }
        else if lift < 0.15 && avgX > 60 && avgY < 120 { kind = "scrape" }
        else if lift < 0.6 && avgX > 30 && avgX < 350 && avgY < 120 && recent.count >= 6 { kind = "stroll" }
        guard let kind, now - (dragMotionSaid[kind] ?? 0) > 3.5 else { return }
        dragMotionSaid[kind] = now
        js("window.ArthurHost && ArthurHost.dragMotion && ArthurHost.dragMotion('\(kind)')")
    }

    /// Where she put him down, once he's landed from being carried.
    private func setDownKind(target: Ledge, x: CGFloat) -> String {
        let screen = screenUnderFeet()
        if let y0 = dragStartLedgeY, abs(y0 - target.y) < 4, abs(x - dragStartX) < 50 { return "same" }
        if target.kind == .window { return "window" }
        if x - screen.minX < screen.width * 0.1 || screen.maxX - x < screen.width * 0.1 { return "corner" }
        return "floor"
    }

    /// Let go of him: he keeps the speed the mouse was moving at.
    private func releaseDrag() {
        var vx: CGFloat = 0, vy: CGFloat = 0
        if let first = dragSamples.first, let last = dragSamples.last, last.t - first.t > 0.012 {
            let span = CGFloat(last.t - first.t)
            vx = (last.p.x - first.p.x) / span
            vy = -(last.p.y - first.p.y) / span   // screen up = negative fall speed
        }
        let cap: CGFloat = 2600
        vx = max(-cap, min(cap, vx)); vy = max(-cap, min(cap, vy))
        flungHard = hypot(vx, vy) > 1100
        dragSamples = []
        js("window.ArthurHost && ArthurHost.dropped && ArthurHost.dropped(\(String(format: "%.2f", dragMaxLift)), \(flungHard), \(String(format: "%.2f", CACurrentMediaTime() - dragStartedAt)))")
        startFalling(vx: vx, vy: vy)
    }

    private func land(on target: Ledge, at x: CGFloat) {
        dropThroughY = nil
        if hopping, itemState != nil, let base = climbBaseY, target.y - base > bodyHeight() * 1.2 {
            climbedAt = CACurrentMediaTime()       // a real climb, all the way up here
        } else if !hopping, let base = climbBaseY, target.y < base + 3 {
            climbBaseY = nil                       // back down where he started from
        }
        hopping = false
        if let aim = hopAimY, target.y < aim - 3 {
            noHopsUntil = CACurrentMediaTime() + 20
            NSLog("Arthur's jump fell short (aimed %.0f, landed %.0f)", aim, target.y)
        }
        hopAimY = nil
        if stranded || rescuedPending {
            // Down at last: carried down by her, or the window went out from under him.
            setStranded(false, rescued: rescuedPending)
            rescuedPending = false
        }
        if target.kind != .window { excitedClimb = false }
        moveFeet(to: NSPoint(x: x, y: target.y))
        ledge = target
        motion = .resting
        NSLog("Arthur landed at y=%.0f on %@", target.y, "\(target.kind)")
        nextSupportCheck = CACurrentMediaTime() + 0.8
        if target.kind == .window { nextWanderAt = CACurrentMediaTime() + Double.random(in: 2.5...6) }
        js("window.ArthurHost && ArthurHost.landed()")
        rememberPosition()
        let fell = fallPeakY - target.y
        fallPeakY = target.y
        if fell > 40 { NSLog("Arthur fell %.0f (body %.0f)%@", fell, bodyHeight(), supportLost ? " (floated)" : "") }
        let floated = supportLost
        if braveDropPending {
            braveDropPending = false
            if !floated, fell > bodyHeight() * 1.5, itemState != nil { braveLandedAt = CACurrentMediaTime() }
        }
        supportLost = false
        setFloating(false)
        if floated {
            // Drifted down under his umbrella: no harm done.
        } else if splatOnLanding {
            splatOnLanding = false
            flungHard = false
            js("window.ArthurHost && ArthurHost.knock && ArthurHost.knock('splat')")
        } else if fell > bodyHeight() * 2.8 {   // most of the screen, for him
            // A long way down: he lands in a heap, legs splayed, face in his hands.
            flungHard = false
            js("window.ArthurHost && ArthurHost.hardLanding && ArthurHost.hardLanding()")
        } else if flungHard {
            flungHard = false
            js("window.ArthurHost && ArthurHost.thrown && ArthurHost.thrown()")
        } else if carried {
            js("window.ArthurHost && ArthurHost.setDown && ArthurHost.setDown('\(setDownKind(target: target, x: x))')")
        }
        carried = false
        if leaveWhenGrounded {
            if target.kind == .floor { leaveWhenGrounded = false; beginExit() } else { startFalling() }
        }
    }

    // MARK: - Sent away, coming back

    private func sendAway(untilMs: Double?) {
        pendingAwayUntil = untilMs.map { $0 / 1000 } ?? 0
        sittingUntil = nil
        if pageSeated { sit(false) }
        stopWalking(tellPage: true)
        if ledge?.kind == .floor { beginExit() } else { leaveWhenGrounded = true; startFalling() }
    }

    private func screenUnderFeet() -> NSRect {
        let feet = feetOnScreen() ?? NSPoint(x: panel.frame.midX, y: panel.frame.minY)
        return NSScreen.screens.first { $0.frame.minX <= feet.x && feet.x <= $0.frame.maxX }?.frame
            ?? NSScreen.main?.frame ?? panel.frame
    }

    private func beginExit() {
        let screen = screenUnderFeet()
        let feetX = feetOnScreen()?.x ?? panel.frame.midX
        let direction: CGFloat = feetX > screen.midX ? 1 : -1
        prefs.awaySide = Double(direction)
        js("window.ArthurHost ? ArthurHost.walk(\(direction > 0 ? 1 : -1)) : false") { [weak self] ok in
            guard let self else { return }
            if (ok as? Bool) == true { self.motion = .leaving(direction: direction) } else { self.finishExit() }
        }
    }

    private func finishExit() {
        js("window.ArthurHost && ArthurHost.stop()")
        motion = .resting
        panel.orderOut(nil)
        prefs.hidden = true
        prefs.awayUntil = pendingAwayUntil ?? 0
        pendingAwayUntil = nil
        tellPresence()
    }

    /// Whether he's on the desktop at all (not hidden, not sent away), so he
    /// doesn't chatter to an empty room.
    private func tellPresence() {
        js("window.ArthurHost && ArthurHost.present && ArthurHost.present(\(!prefs.hidden))")
    }

    private func checkAwayReturn() {
        guard let until = prefs.awayUntil, until > 0, Date().timeIntervalSince1970 >= until else { return }
        comeBack()
    }

    private func comeBack() {
        prefs.awayUntil = nil
        prefs.hidden = false
        leaveWhenGrounded = false
        tellPresence()
        guard feetCSS != nil else { panel.orderFrontRegardless(); startFalling(); return }
        let screen = NSScreen.screens.first { $0.frame.contains(NSPoint(x: panel.frame.midX, y: panel.frame.midY)) }
            ?? NSScreen.main ?? NSScreen.screens[0]
        let side = CGFloat(prefs.awaySide >= 0 ? 1 : -1)
        let floor = screen.frame.minY
        let startX = side > 0 ? screen.frame.maxX + panel.frame.width * 0.5 : screen.frame.minX - panel.frame.width * 0.5
        moveFeet(to: NSPoint(x: startX, y: floor))
        ledge = ledges().first { $0.kind == .floor && $0.minX <= screen.frame.midX && screen.frame.midX <= $0.maxX }
        panel.orderFrontRegardless()
        let inward = -side
        let target = side > 0 ? screen.frame.maxX - CGFloat.random(in: 160...360) * max(zoom, 0.5)
                              : screen.frame.minX + CGFloat.random(in: 160...360) * max(zoom, 0.5)
        js("window.ArthurHost ? ArthurHost.walk(\(inward > 0 ? 1 : -1)) : false") { [weak self] ok in
            guard let self else { return }
            if (ok as? Bool) == true {
                self.motion = .entering(targetX: target, direction: inward)
            } else {
                self.moveFeet(to: NSPoint(x: target, y: floor))
                self.arrivedBack()
            }
        }
    }

    private func arrivedBack() {
        js("window.ArthurHost && ArthurHost.stop()")
        motion = .resting
        rememberPosition()
        startFalling()
        js("window.ArthurHost && ArthurHost.returned && ArthurHost.returned()")
    }

    private func stopWalking(tellPage: Bool = true) {
        fleeing = false
        if visitingCursor {
            visitingCursor = false
            // Arrived beside her cursor: say hello to it (the page does the reaching).
            let mouse = NSEvent.mouseLocation, f = panel.frame
            let css = CGPoint(x: (mouse.x - f.minX) / zoom, y: (f.maxY - mouse.y) / zoom)
            js("window.ArthurHost && ArthurHost.visitCursor && ArthurHost.visitCursor(\(Int(css.x)), \(Int(css.y)))")
        }
        if case .walking = motion {
            motion = .resting
            if tellPage { js("window.ArthurHost && ArthurHost.stop()") }
            rememberPosition()
        }
    }

    private func sit(_ on: Bool, for seconds: ClosedRange<Double>? = nil) {
        js("window.ArthurHost ? ArthurHost.sit(\(on)) : false") { [weak self] ok in
            guard let self, (ok as? Bool) == true else { return }
            self.sittingUntil = on ? seconds.map { CACurrentMediaTime() + Double.random(in: $0) } : nil
        }
    }

    private func maybeWander(now: CFTimeInterval) {
        // Stuck up high only while he wanted down (after his things); once that's over he just lives up here.
        if stranded, itemState == nil, cornerSeekUntil == nil, case .resting = motion { setStranded(false) }
        guard itemState == nil, !stranded, cornerSeekUntil == nil else { return }   // busy with his things, stuck up high, or off to his corner
        guard prefs.wanders, now >= nextWanderAt, let ledge else { return }
        // Seated: stay put until he decides to get up.
        if pageSeated {
            guard let until = sittingUntil, now >= until else { return }
            sit(false)
            nextWanderAt = now + Double.random(in: 3...8)
            return
        }
        // A window edge a little above and within reach: up he goes. One step at a
        // time, so windows stacked like stairs get him all the way up.
        if prefs.climbsWindows, pageCanWander, Double.random(in: 0...1) < 0.3, climb(from: ledge) {
            nextWanderAt = now + Double.random(in: 4...10)
            return
        }
        // Up on a window, now and then he hops back down (from the middle, not only the ends).
        if ledge.hasDropAtEnds, pageCanWander, Double.random(in: 0...1) < 0.12, hopDownHere(towards: Bool.random() ? 1 : -1) {
            nextWanderAt = now + Double.random(in: 6...14)
            return
        }
        // Now and then he wanders over to where she's working, of his own accord.
        if pageCanWander, Double.random(in: 0...1) < 0.07, let feet = feetOnScreen() {
            let mouse = NSEvent.mouseLocation
            if mouse.x > ledge.minX + 40, mouse.x < ledge.maxX - 40, mouse.y > feet.y - 40, mouse.y - feet.y < panel.frame.height * 2.2,
               abs(mouse.x - feet.x) > 80, now - lastMouseMoveAt < 20 {
                let dir: CGFloat = mouse.x > feet.x ? 1 : -1
                let target = mouse.x - dir * 50 * max(zoom, 0.5)
                nextWanderAt = now + Double.random(in: 20...40)
                js("window.ArthurHost ? ArthurHost.walk(\(dir > 0 ? 1 : -1)) : false") { [weak self] ok in
                    guard let self, (ok as? Bool) == true, case .resting = self.motion else { return }
                    self.visitingCursor = true
                    self.motion = .walking(targetX: target, direction: dir)
                }
                return
            }
        }
        // Window tops are for sitting on and watching; the screen bottom less so.
        let sitChance: Double = ledge.kind == .window ? 0.6 : (ledge.kind == .dock ? 0.35 : 0.2)
        if pageCanSit, Double.random(in: 0...1) < sitChance {
            nextWanderAt = now + Double.random(in: 14...45)
            sit(true, for: 45...200)
            return
        }
        guard pageCanWander, let feet = feetOnScreen() else { return }
        nextWanderAt = now + Double.random(in: 14...45)
        guard Double.random(in: 0...1) < 0.55 else { return }
        let reach = CGFloat.random(in: 90...360) * max(zoom, 0.5)
        let margin = panel.frame.width * 0.25
        var direction: CGFloat = Bool.random() ? 1 : -1
        var target = feet.x + direction * reach
        // On a window top he sometimes strolls right off the end, Shimeji-style;
        // on the screen bottom he turns before the edge.
        let lo = ledge.hasDropAtEnds ? ledge.minX - 40 : ledge.minX + margin
        let hi = ledge.hasDropAtEnds ? ledge.maxX + 40 : ledge.maxX - margin
        if target < lo || target > hi { direction = -direction; target = feet.x + direction * reach }
        target = min(max(target, lo), hi)
        guard abs(target - feet.x) > 30 else { return }
        js("window.ArthurHost ? ArthurHost.walk(\(direction > 0 ? 1 : -1)) : false") { [weak self] ok in
            guard let self, (ok as? Bool) == true, case .resting = self.motion else { return }
            self.motion = .walking(targetX: target, direction: direction)
        }
    }

    /// Jump from where he stands onto a nearby higher window edge, if there is one.
    private func climb(from current: Ledge) -> Bool {
        guard !tired, CACurrentMediaTime() >= noHopsUntil, let feet = feetOnScreen() else { return false }
        let maxRise = panel.frame.height * 0.75
        let reach = 420 * max(zoom, 0.5)
        let margin: CGFloat = 36
        let options = ledges().compactMap { l -> (Ledge, CGFloat)? in
            guard l.kind == .window, l.maxX - l.minX >= margin * 2 + 20 else { return nil }
            let rise = l.y - current.y
            guard rise > 30, rise <= maxRise else { return nil }
            let x = min(max(feet.x, l.minX + margin), l.maxX - margin)
            guard abs(x - feet.x) <= reach, headroom(on: l, at: x) else { return nil }
            return (l, x)
        }
        // The nearest step up, not the tallest leap.
        guard let (target, landX) = options.min(by: { $0.0.y < $1.0.y }) else { return false }
        let g = Self.gravity
        let clearance: CGFloat = 46
        let up = sqrt(2 * g * (target.y - feet.y + clearance))
        let flight = up / g + sqrt(2 * clearance / g)
        // A sideways nudge onto the edge even when it's straight above.
        let aimX = abs(landX - feet.x) < 12 ? landX + (landX < (target.minX + target.maxX) / 2 ? 14 : -14) : landX
        sittingUntil = nil
        hopping = true
        stamina -= 0.08                     // climbing is tiring
        excitedClimb = false
        hopAimY = target.y
        startFalling(vx: (aimX - feet.x) / flight, vy: -up, hop: true)
        return true
    }

    // Riding the window he's standing on while she drags it about.
    private var rideFrame: CGRect?
    private var rideWindow: Int?
    private var rideLevel = 0
    private var rideSpeed: CGFloat = 0
    private var rideStillSince: CFTimeInterval = 0
    private func rideWindow(now: CFTimeInterval, dt: CGFloat) {
        let standing: Bool
        switch motion { case .resting, .walking: standing = true; default: standing = false }
        guard standing, let ledge, ledge.kind == .window, let num = ledge.windowNumber, dt > 0 else {
            rideFrame = nil; rideWindow = nil; setRide(0); return
        }
        let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(num)) as? [[String: Any]] ?? []
        guard let info = list.first, let b = info[kCGWindowBounds as String] as? [String: CGFloat],
              let x = b["X"], let y = b["Y"], let w = b["Width"], let h = b["Height"] else { return }
        // Switched to another desktop / full-screen app: the window is still there,
        // just not on screen. That's the floor going, not her flinging him.
        if (info[kCGWindowIsOnscreen as String] as? Bool) != true {
            rideFrame = nil; rideWindow = nil; setRide(0)
            self.ledge = nil
            startFalling(); supportLost = true
            return
        }
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        let frame = CGRect(x: x, y: primaryHeight - y - h, width: w, height: h)
        defer { rideFrame = frame; rideWindow = num }
        guard rideWindow == num, let last = rideFrame, last.size == frame.size else { return }
        let dx = frame.minX - last.minX, dy = frame.maxY - last.maxY
        let speed = hypot(dx, dy) / dt
        rideSpeed = rideSpeed * 0.7 + speed * 0.3
        if dx == 0 && dy == 0 {
            if rideLevel > 0 && now - rideStillSince > 0.6 { setRide(0) }
            return
        }
        rideStillSince = now
        if hypot(dx, dy) > 160 {
            // Jumped a long way in one frame (a desktop switch, a window snapped into
            // place): no hand could drag it that fast. The ground went; he floats down.
            setRide(0)
            self.ledge = nil
            startFalling(); supportLost = true
            return
        }
        if speed > 2600 {
            // Yanked out from under him: off he flies, with the window's speed.
            setRide(0)
            panel.setFrameOrigin(NSPoint(x: panel.frame.minX + dx, y: panel.frame.minY + dy))
            self.ledge = nil
            startFalling(vx: dx / dt * 0.8, vy: -dy / dt * 0.8)
            return
        }
        panel.setFrameOrigin(NSPoint(x: panel.frame.minX + dx, y: panel.frame.minY + dy))
        self.ledge = Ledge(y: frame.maxY, minX: ledge.minX + dx, maxX: ledge.maxX + dx, kind: .window, windowNumber: num)
        if case .walking = motion { stopWalking() }
        setRide(rideSpeed > 700 ? 2 : 1)
    }

    private func setRide(_ level: Int) {
        guard level != rideLevel else { return }
        rideLevel = level
        js("window.ArthurHost && ArthurHost.ride && ArthurHost.ride(\(level))")
    }

    /// How much of the top of his window is behind the menu bar (CSS px), so the page
    /// can keep his speech bubble where she can read it.
    private var lastTopCut = -1
    private func reportTopCut() {
        let f = panel.frame
        let top = NSScreen.screens.first { $0.frame.minX <= f.midX && f.midX <= $0.frame.maxX }?.visibleFrame.maxY ?? f.maxY
        let cut = Int(max(0, f.maxY - top) / max(zoom, 0.1))
        guard abs(cut - lastTopCut) >= 2 || (cut == 0) != (lastTopCut == 0) else { return }
        lastTopCut = cut
        js("window.ArthurHost && ArthurHost.topCut && ArthurHost.topCut(\(cut))")
    }

    private func tick() {
        let now = CACurrentMediaTime()
        let dt = CGFloat(min(now - lastTick, 1.0 / 20.0))
        lastTick = now
        if now >= nextOutfitCheck { nextOutfitCheck = now + 1; checkOutfitExpiry(); checkAwayReturn() }
        updateStamina(now: now, dt: dt)
        if now >= nextEdgeFearCheck { nextEdgeFearCheck = now + 0.3; updateEdgeFear() }
        reportTopCut()
        stepTowardsCorner(now: now)
        rideWindow(now: now, dt: dt)
        let m = NSEvent.mouseLocation
        if hypot(m.x - lastMouse.x, m.y - lastMouse.y) > 1 { lastMouse = m; lastMouseMoveAt = now }
        if now >= nextIdleReport {
            nextIdleReport = now + 15
            js("window.ArthurHost && ArthurHost.idleFor && ArthurHost.idleFor(\(Int(now - lastMouseMoveAt)))")
        }
        updateItem(now: now, dt: dt)
        updateGift(dt: dt)
        guard panel.isVisible else { return }
        let mouse = NSEvent.mouseLocation

        switch motion {
        case .dragging(let offset):
            if NSEvent.pressedMouseButtons & 1 == 0 {
                releaseDrag()   // released outside the page, e.g. after a fast flick
            } else {
                var origin = NSPoint(x: mouse.x - offset.x, y: mouse.y - offset.y)
                // His hair may touch the underside of the menu bar, no further.
                if let head = screenRects().map(\.maxY).max(),
                   let ceiling = NSScreen.screens.first(where: { $0.frame.minX <= mouse.x && mouse.x <= $0.frame.maxX })?.visibleFrame.maxY {
                    origin.y = min(origin.y, ceiling - (head - panel.frame.minY))
                }
                panel.setFrameOrigin(origin)
                let lift = liftNow()
                dragMaxLift = max(dragMaxLift, lift)
                if now >= nextLiftReport {
                    nextLiftReport = now + 0.25
                    js("window.ArthurHost && ArthurHost.lifted && ArthurHost.lifted(\(String(format: "%.2f", lift)), \(String(format: "%.1f", now - dragStartedAt)))")
                }
                dragSamples.append((now, mouse))
                dragSamples.removeAll { now - $0.t > 0.1 }
                dragTrail.append((now, mouse))
                if now >= nextDragMotionRead { nextDragMotionRead = now + 0.1; readDragMotion(now: now, lift: lift) }
            }
        case .falling(var vx, var vy):
            guard let feet = feetOnScreen() else { break }
            vy += Self.gravity * dt
            if supportLost && vy > 240 { vy = 240; setFloating(true) }   // umbrella up
            if !hopping { vx *= max(0, 1 - 0.35 * dt) }   // a little air drag (not on his own jumps)
            var nextX = feet.x + vx * dt
            let nextY = feet.y - vy * dt
            // Walls: bounce off the sides of the screen he's over.
            let screen = NSScreen.screens.first { $0.frame.minX <= feet.x && feet.x <= $0.frame.maxX }?.frame
                ?? NSScreen.main?.frame ?? .zero
            let margin = panel.frame.width * 0.22
            if nextX < screen.minX + margin, vx < 0, !NSScreen.screens.contains(where: { $0.frame.maxX >= screen.minX - 1 && $0.frame.minX < screen.minX }) {
                bonk(abs(vx)); nextX = screen.minX + margin; vx = -vx * 0.45
            } else if nextX > screen.maxX - margin, vx > 0, !NSScreen.screens.contains(where: { $0.frame.minX <= screen.maxX + 1 && $0.frame.maxX > screen.maxX }) {
                bonk(abs(vx)); nextX = screen.maxX - margin; vx = -vx * 0.45
            }
            // Ceiling: his head (not the empty top of the window) bonks the top of the screen.
            let headTop = screenRects().map(\.maxY).max() ?? (feet.y + panel.frame.height * 0.6)
            let ceiling = NSScreen.screens.first { $0.frame.minX <= feet.x && feet.x <= $0.frame.maxX }?.visibleFrame.maxY ?? screen.maxY
            if vy < 0, headTop - vy * dt > ceiling { bonk(-vy); vy = 0 }
            fallPeakY = max(fallPeakY, feet.y)
            var under = vy > 0 ? ledge(below: feet.y, at: nextX) : nil
            if let u = under, let through = dropThroughY, abs(u.y - through) < 3 { under = ledge(below: through - 4, at: nextX) }
            if vy > 0, let target = under, nextY <= target.y {
                land(on: target, at: nextX)
            } else if nextY < (NSScreen.screens.map(\.frame.minY).min() ?? 0) - 200 {
                prefs.anchor = nil; applyScale()   // fell off every screen; put him back
            } else {
                panel.setFrameOrigin(NSPoint(x: panel.frame.minX + (nextX - feet.x), y: panel.frame.minY - vy * dt))
                motion = .falling(vx: vx, vy: vy)
            }
        case .leaving(let direction):
            let step = Self.walkSpeed * 2.2 * zoom * dt * direction
            panel.setFrameOrigin(NSPoint(x: panel.frame.minX + step, y: panel.frame.minY))
            let screen = screenUnderFeet()
            let gone = direction > 0 ? panel.frame.minX > screen.maxX - panel.frame.width * 0.1
                                     : panel.frame.maxX < screen.minX + panel.frame.width * 0.1
            if gone || feetOnScreen().map({ $0.x > screen.maxX + 40 || $0.x < screen.minX - 40 }) == true {
                finishExit()
            }
        case .entering(let targetX, let direction):
            guard let feet = feetOnScreen() else { arrivedBack(); break }
            let step = Self.walkSpeed * 2.2 * zoom * dt * direction
            if (direction > 0 && feet.x + step >= targetX) || (direction < 0 && feet.x + step <= targetX) {
                arrivedBack()
            } else {
                panel.setFrameOrigin(NSPoint(x: panel.frame.minX + step, y: panel.frame.minY))
            }
        case .walking(let targetX, let direction):
            guard let feet = feetOnScreen(), let ledge else { stopWalking(); break }
            let step = Self.walkSpeed * zoom * dt * direction * (fleeing ? (tired ? 1.4 : 3.2) : 1)
            let x = feet.x + step
            if (direction > 0 && x >= targetX) || (direction < 0 && x <= targetX) || !pageCanWander {
                stopWalking()
            } else if (x < ledge.minX + 4 || x > ledge.maxX - 4),
                      let next = ledges().first(where: { abs($0.y - ledge.y) < 3 && $0.minX != ledge.minX
                          && (direction > 0 ? ($0.minX <= ledge.maxX + 14 && $0.maxX > ledge.maxX + 10)
                                            : ($0.maxX >= ledge.minX - 14 && $0.minX < ledge.minX - 10)) }) {
                // The edge carries on (another window at the same height): just step across.
                self.ledge = next
                panel.setFrameOrigin(NSPoint(x: panel.frame.minX + step, y: panel.frame.minY))
            } else if x < ledge.minX + 4 || x > ledge.maxX - 4 {
                js("window.ArthurHost && ArthurHost.stop()")
                if ledge.hasDropAtEnds && tooHighToDrop(ledge, at: x < ledge.minX + 4 ? ledge.minX - 30 : ledge.maxX + 30) {
                    motion = .resting
                    if itemState != nil || cornerSeekUntil != nil {
                        fleeing = false
                        setStranded(true)          // wants down, peers over the edge, and won't (yet)
                    } else {
                        // Just strolling: a look over the edge, a frown, and he'll wander back.
                        fleeing = false
                        peekUntil = now + Double.random(in: 1.5...3)
                        nextWanderAt = max(nextWanderAt, now + Double.random(in: 3...7))
                        rememberPosition()
                    }
                } else if ledge.hasDropAtEnds {
                    // Step right off the end before dropping: at a run his last step stops short
                    // of the edge, and falling straight down there lands him on the same window.
                    let edgeX = direction > 0 ? ledge.maxX + 4 : ledge.minX - 4
                    panel.setFrameOrigin(NSPoint(x: panel.frame.minX + (edgeX - feet.x), y: panel.frame.minY))
                    startFalling(vx: direction * 90)
                } else { motion = .resting; rememberPosition() }
            } else {
                panel.setFrameOrigin(NSPoint(x: panel.frame.minX + step, y: panel.frame.minY))
            }
        case .resting:
            if now >= nextSupportCheck, let feet = feetOnScreen() {
                nextSupportCheck = now + 0.7
                // The window he stood on moved, shrank or closed: down he goes.
                // At the very end of an edge (stopped there, or leaning over to look
                // down) his feet sit a hair past where a fresh lookup counts as on it;
                // the same edge still there means he's still standing, not floating off.
                if let current = self.ledge,
                   ledges().contains(where: { abs($0.y - current.y) < 2 && $0.kind == current.kind
                       && $0.minX - 14 <= feet.x && feet.x <= $0.maxX + 14 && abs(feet.y - $0.y) <= 3 }) {
                    // still on it
                } else if let target = ledge(below: feet.y + 2, at: feet.x) {
                    if feet.y - target.y > 3 { startFalling(); supportLost = true } else { ledge = target }
                } else {
                    startFalling(); supportLost = true
                }
            }
            maybeWander(now: now)
        }

        updateHitTesting(mouse: mouse)
        forwardPointer(mouse: mouse, now: now)
    }

    private func updateHitTesting(mouse: NSPoint) {
        let over = isOverArthur(mouse)
        let dragging: Bool = { if case .dragging = motion { return true }; return false }()
        let ignore = prefs.clickThrough || !(over || dragging)
        if panel.ignoresMouseEvents != ignore { panel.ignoresMouseEvents = ignore }
        if prefs.clickThrough {
            let target = over ? min(Self.hoverFadeAlpha, prefs.opacity) : prefs.opacity
            if abs(panel.alphaValue - target) > 0.01 {
                NSAnimationContext.runAnimationGroup { ctx in
                    ctx.duration = 0.18
                    panel.animator().alphaValue = target
                }
            }
        }
    }

    /// The page can't see the mouse while it passes through, so tell it,
    /// keeping his eyes following the pointer when it comes near.
    private func forwardPointer(mouse: NSPoint, now: CFTimeInterval) {
        guard panel.ignoresMouseEvents, !prefs.clickThrough else { return }
        let f = panel.frame
        let near = f.insetBy(dx: -120 * zoom, dy: -120 * zoom).contains(mouse)
        if !near {
            if lastPointerSent != nil { lastPointerSent = nil; js("window.ArthurHost && ArthurHost.leave()") }
            return
        }
        guard now - lastPointerAt > 0.08 else { return }
        let css = CGPoint(x: (mouse.x - f.minX) / zoom, y: (f.maxY - mouse.y) / zoom)
        if let last = lastPointerSent, abs(last.x - css.x) < 2, abs(last.y - css.y) < 2 { return }
        lastPointerSent = css
        lastPointerAt = now
        js("window.ArthurHost && ArthurHost.pointer(\(Int(css.x)),\(Int(css.y)))")
    }

    // MARK: - Menu bar

    private func makeStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "pawprint.fill", accessibilityDescription: "Arthur 桌宠")
        }
        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false
        statusItem.menu = menu
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()

        let visible = panel.isVisible
        if let until = prefs.awayUntil {
            let f = DateFormatter(); f.dateFormat = "HH:mm"
            let line = until > 0 ? "他走开了，\(f.string(from: Date(timeIntervalSince1970: until))) 回来" : "他走开了，等你叫他回来"
            let note = NSMenuItem(title: line, action: nil, keyEquivalent: "")
            note.isEnabled = false
            menu.addItem(note)
        }
        let toggle = NSMenuItem(title: visible ? "隐藏 Arthur" : (prefs.awayUntil != nil ? "叫他回来" : "显示 Arthur"), action: #selector(toggleVisible), keyEquivalent: "a")
        toggle.keyEquivalentModifierMask = [.option, .command]
        menu.addItem(toggle)

        let through = NSMenuItem(title: "完全穿透（连他身上也点不到）", action: #selector(toggleClickThrough), keyEquivalent: "p")
        through.keyEquivalentModifierMask = [.option, .command]
        through.state = prefs.clickThrough ? .on : .off
        menu.addItem(through)

        let top = NSMenuItem(title: "总在最前面", action: #selector(toggleAlwaysOnTop), keyEquivalent: "")
        top.state = prefs.alwaysOnTop ? .on : .off
        menu.addItem(top)

        let wander = NSMenuItem(title: "自己到处走", action: #selector(toggleWander), keyEquivalent: "")
        wander.state = prefs.wanders ? .on : .off
        menu.addItem(wander)

        let seat = NSMenuItem(title: pageSeated ? "让他站起来" : "让他坐下", action: #selector(toggleSeat), keyEquivalent: "")
        seat.isEnabled = pageSeated || pageCanSit
        menu.addItem(seat)

        let climb = NSMenuItem(title: "站到窗口顶上", action: #selector(toggleClimb), keyEquivalent: "")
        climb.state = prefs.climbsWindows ? .on : .off
        menu.addItem(climb)

        menu.addItem(.separator())
        menu.addItem(sectionHeader("大小"))
        for (index, (label, value)) in CompanionPreferences.scales.enumerated() {
            let item = NSMenuItem(title: label, action: #selector(chooseScale(_:)), keyEquivalent: "")
            item.tag = index
            item.state = abs(prefs.scale - value) < 0.01 ? .on : .off
            item.indentationLevel = 1
            menu.addItem(item)
        }
        menu.addItem(sectionHeader("衣服（在“戳一下”里给他换）"))
        if prefs.outfit != "auto" {
            let label = CompanionPreferences.outfits.first { $0.1 == prefs.outfit }?.0 ?? prefs.outfit
            var line = "现在穿着：\(label)"
            if let until = prefs.outfitUntil {
                let f = DateFormatter(); f.dateFormat = "M月d日 HH:mm"
                line += "，到 \(f.string(from: Date(timeIntervalSince1970: until)))"
            } else { line += "，没有期限" }
            let now = NSMenuItem(title: line, action: nil, keyEquivalent: "")
            now.isEnabled = false
            now.indentationLevel = 1
            menu.addItem(now)
            let reset = NSMenuItem(title: "恢复自动（让他自己挑）", action: #selector(resetOutfit), keyEquivalent: "")
            reset.indentationLevel = 1
            menu.addItem(reset)
        } else {
            let now = NSMenuItem(title: "自动：出门穿他自己挑的，在家睡衣", action: nil, keyEquivalent: "")
            now.isEnabled = false
            now.indentationLevel = 1
            menu.addItem(now)
        }
        menu.addItem(sectionHeader("眼镜"))
        for (index, (label, value)) in CompanionPreferences.glassesModes.enumerated() {
            let item = NSMenuItem(title: label, action: #selector(chooseGlasses(_:)), keyEquivalent: "")
            item.tag = index
            item.state = prefs.glasses == value ? .on : .off
            item.indentationLevel = 1
            menu.addItem(item)
        }
        menu.addItem(sectionHeader("透明度"))
        for (index, (label, value)) in CompanionPreferences.opacities.enumerated() {
            let item = NSMenuItem(title: label, action: #selector(chooseOpacity(_:)), keyEquivalent: "")
            item.tag = index
            item.state = abs(prefs.opacity - value) < 0.01 ? .on : .off
            item.indentationLevel = 1
            menu.addItem(item)
        }

        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "放回右下角", action: #selector(resetPosition), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "重新读取状态", action: #selector(reloadCompanion), keyEquivalent: "r"))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "退出桌宠", action: #selector(quit), keyEquivalent: "q"))

        for item in menu.items where item.action != nil { item.target = self }
    }

    private func sectionHeader(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    @objc private func toggleVisible() {
        panel.isVisible ? hideCompanion() : showCompanion()
    }

    @objc private func showCompanion() {
        if prefs.awayUntil != nil { comeBack(); return }
        prefs.hidden = false
        panel.orderFrontRegardless()
        startFalling()
        tellPresence()
    }

    @objc private func hideCompanion() {
        prefs.awayUntil = nil
        prefs.hidden = true
        stopWalking()
        panel.orderOut(nil)
        tellPresence()
    }

    @objc private func toggleClickThrough() {
        prefs.clickThrough.toggle()
        applyClickThrough()
        if !panel.isVisible { showCompanion() }
    }

    @objc private func toggleAlwaysOnTop() {
        prefs.alwaysOnTop.toggle()
        applyLevel()
    }

    @objc private func toggleWander() {
        prefs.wanders.toggle()
        if !prefs.wanders { stopWalking() }
    }

    @objc private func toggleSeat() {
        stopWalking()
        // Sat down by hand: stays seated until asked, or until something moves him.
        sit(!pageSeated)
        nextWanderAt = CACurrentMediaTime() + 30
    }

    @objc private func toggleClimb() {
        prefs.climbsWindows.toggle()
        nextSupportCheck = 0
    }

    @objc private func chooseScale(_ sender: NSMenuItem) {
        stopWalking()
        rememberPosition()
        prefs.scale = CompanionPreferences.scales[sender.tag].1
        applyScale()
    }

    @objc private func resetOutfit() {
        prefs.outfit = "auto"
        prefs.outfitUntil = nil
        applyLooks()
    }

    /// The page put something on him (poke menu → wardrobe) and said for how long.
    private func wear(_ mode: String, untilMs: Double?) {
        guard CompanionPreferences.outfits.contains(where: { $0.1 == mode }) else { return }
        prefs.outfit = mode
        prefs.outfitUntil = mode == "auto" ? nil : untilMs.map { $0 / 1000 }
    }

    private func checkOutfitExpiry() {
        guard let until = prefs.outfitUntil, Date().timeIntervalSince1970 >= until else { return }
        prefs.outfit = "auto"
        prefs.outfitUntil = nil
        applyLooks()
        js("window.ArthurHost && ArthurHost.outfitExpired && ArthurHost.outfitExpired()")
    }

    @objc private func chooseGlasses(_ sender: NSMenuItem) {
        prefs.glasses = CompanionPreferences.glassesModes[sender.tag].1
        applyGlasses()
    }

    private func applyGlasses() {
        js("window.ArthurHost && ArthurHost.glasses('\(prefs.glasses)')")
    }

    private func applyLooks() {
        let until = prefs.outfitUntil.map { String(Int($0 * 1000)) } ?? "null"
        js("window.ArthurHost && ArthurHost.outfit('\(prefs.outfit)', \(until))")
        js("window.ArthurHost && ArthurHost.letterRead && ArthurHost.letterRead('\(prefs.letterRead)')")
        js("window.ArthurHost && ArthurHost.touchCount && ArthurHost.touchCount(\(prefs.touchCount))")
        js("window.ArthurHost && ArthurHost.patCount && ArthurHost.patCount(\(prefs.patCount))")
        if let data = try? JSONSerialization.data(withJSONObject: [prefs.pageKV]), let json = String(data: data, encoding: .utf8) {
            js("window.ArthurHost && ArthurHost.kv && ArthurHost.kv(...\(json))")
        }
        if let data = try? JSONSerialization.data(withJSONObject: [prefs.pockets]), let json = String(data: data, encoding: .utf8) {
            js("window.ArthurHost && ArthurHost.pockets && ArthurHost.pockets(...\(json))")
        }
        tellPresence()
        applyGlasses()
    }

    @objc private func chooseOpacity(_ sender: NSMenuItem) {
        prefs.opacity = CompanionPreferences.opacities[sender.tag].1
        applyClickThrough()
    }

    @objc private func resetPosition() {
        stopWalking()
        prefs.anchor = nil
        applyScale()
        showCompanion()
    }

    @objc private func reloadCompanion() {
        loadCompanion()
        showCompanion()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    // MARK: - Global shortcuts (⌥⌘A show/hide, ⌥⌘P full click-through)
    // Carbon hot keys need no Accessibility permission.

    private func registerHotKeys() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let me = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
            guard let event, let userData else { return noErr }
            var id = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                              nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
            let app = Unmanaged<ArthurDesktopCompanionApp>.fromOpaque(userData).takeUnretainedValue()
            DispatchQueue.main.async {
                switch id.id {
                case 1: app.toggleVisible()
                case 2: app.toggleClickThrough()
                default: break
                }
            }
            return noErr
        }, 1, &spec, me, nil)

        let signature = OSType(0x4152_5448) // 'ARTH'
        let modifiers = UInt32(optionKey | cmdKey)
        for (number, key) in [(UInt32(1), UInt32(kVK_ANSI_A)), (UInt32(2), UInt32(kVK_ANSI_P))] {
            var ref: EventHotKeyRef?
            RegisterEventHotKey(key, modifiers, EventHotKeyID(signature: signature, id: number),
                                GetApplicationEventTarget(), 0, &ref)
            hotKeys.append(ref)
        }
    }

    // MARK: - Page

    private func loadCompanion() {
        retry?.cancel()
        hitRects = []
        feetCSS = nil
        settledOnce = false
        var request = URLRequest(url: companionURL)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 5
        webView.load(request)
    }

    private func scheduleRetry() {
        retry?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.loadCompanion() }
        retry = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: work)
    }

    @objc private func computerOpened() {
        // Give the screen a moment to come up so she actually sees it.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in self?.greetIfFirstToday() }
    }

    private func greetIfFirstToday(attempt: Int = 0) {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        let today = f.string(from: Date())
        guard prefs.lastGreetDay != today, panel.isVisible, prefs.awayUntil == nil else { return }
        js("window.ArthurHost && ArthurHost.greet ? ArthurHost.greet() : 'not-ready'") { [weak self] result in
            guard let self else { return }
            // Only counts once he actually said it (not while he's asleep, say).
            if (result as? Bool) == true {
                self.prefs.lastGreetDay = today
                NSLog("Arthur greeted her for %@", today)
            } else if attempt < 4 {
                // The page may still be building, or he's mid-something: try again shortly.
                DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in self?.greetIfFirstToday(attempt: attempt + 1) }
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.greetIfFirstToday() }
        // The page builds ArthurHost asynchronously after load; try a few times.
        for delay in [0.5, 1.5, 4.0] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.applyLooks() }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        scheduleRetry()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        scheduleRetry()
    }
}

@main
private enum ArthurDesktopCompanionMain {
    static func main() {
        let application = NSApplication.shared
        let delegate = ArthurDesktopCompanionApp()
        application.delegate = delegate
        application.run()
        withExtendedLifetime(delegate) {}
    }
}

private extension CGFloat {
    var nonZero: CGFloat? { self == 0 ? nil : self }
}
