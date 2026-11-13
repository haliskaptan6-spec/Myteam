#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SAHA Yayın: yakalama kartı veya IP kameradan görüntü alır, aynı Wi-Fi'deki tablet/bilgisayarlara yayınlar.

Gerekenler: Python 3.8+ ve ffmpeg (ffmpeg.exe'yi bu dosyanın yanına koyabilirsin).
Çalıştırma:  python saha-yayin.py
Görüntüler SAHA-Kayitlar klasörüne kaydedilir (bu dosyanın yanında).
"""
import argparse, collections, csv, json, os, queue, random, re, shutil, socket, string, subprocess, sys, tempfile, threading, time
from datetime import datetime
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

VERSION = "1.0"
IS_WIN = sys.platform.startswith("win")
HERE = os.path.dirname(os.path.abspath(__file__))
SEG_SECONDS = 2
LOCK = threading.Lock()


class Session:
    pass


STATE = {"sess": None}
CFG = {"ffmpeg": None, "ffprobe": None, "out": None, "codec": "h264", "port": 8765}


def find_ffmpeg(arg):
    if arg:
        return arg
    local = os.path.join(HERE, "ffmpeg.exe" if IS_WIN else "ffmpeg")
    if os.path.isfile(local):
        return local
    return shutil.which("ffmpeg")


def run_capture(cmd, timeout=20):
    kw = {}
    if IS_WIN:
        kw["creationflags"] = 0x08000000
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, **kw)
        return p.stdout.decode("utf-8", "replace")
    except Exception as e:
        return str(e)


def list_devices():
    """Windows: DirectShow cihazlarını ffmpeg ile listeler. Linux: /dev/video*."""
    out = {"video": [], "audio": []}
    if not CFG["ffmpeg"]:
        return out
    if IS_WIN:
        txt = run_capture([CFG["ffmpeg"], "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"])
        for line in txt.splitlines():
            if "Alternative name" in line:
                continue
            m = re.search(r'"([^"]+)"\s+\((video|audio)\)', line)
            if m and m.group(1) not in out[m.group(2)]:
                out[m.group(2)].append(m.group(1))
    else:
        import glob
        out["video"] = sorted(glob.glob("/dev/video*"))
    return out


def lan_ips():
    ips = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.append(info[4][0])
    except Exception:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.append(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    seen, res = set(), []
    for ip in ips:
        if ip.startswith("127.") or ip.startswith("169.254.") or ip in seen:
            continue
        seen.add(ip)
        res.append(ip)

    def rank(ip):
        if ip.startswith("192.168."):
            return 0
        if ip.startswith("10."):
            return 1
        m = re.match(r"172\.(\d+)\.", ip)
        if m and 16 <= int(m.group(1)) <= 31:
            return 2
        return 3
    return sorted(res, key=rank)


def read_segments(s):
    """list.csv: ad,başlangıç,bitiş"""
    segs = []
    try:
        with open(s.listfile, "r", encoding="utf-8", errors="replace") as f:
            for row in csv.reader(f):
                if len(row) >= 3:
                    try:
                        segs.append([row[0], round(float(row[1]), 3), round(float(row[2]), 3)])
                    except ValueError:
                        pass
    except FileNotFoundError:
        pass
    # yalnızca dosyası gerçekten var olanlar
    return [x for x in segs if os.path.isfile(os.path.join(s.segdir, x[0]))]


def running(s):
    return bool(s and s.proc and s.proc.poll() is None)


def build_cmd(p, s):
    t = p.get("type")
    fps = int(p.get("fps") or 30)
    w = int(p.get("width") or 0)
    h = int(p.get("height") or 0)
    codec = CFG["codec"]
    inp = []
    audio_ok = True
    if t == "capture":
        v = p.get("video") or ""
        a = p.get("audio") or ""
        if not v:
            raise ValueError("Görüntü kaynağı seçilmedi")
        if IS_WIN:
            inp = ["-f", "dshow", "-rtbufsize", "256M"]
            if w and h:
                inp += ["-video_size", "%dx%d" % (w, h)]
            inp += ["-framerate", str(fps), "-i", "video=%s%s" % (v, (":audio=" + a) if a else "")]
        else:
            inp = ["-f", "v4l2"]
            if w and h:
                inp += ["-video_size", "%dx%d" % (w, h)]
            inp += ["-framerate", str(fps), "-i", v]
        audio_ok = bool(a)
    elif t == "ip":
        url = (p.get("url") or "").strip()
        if not re.match(r"^(rtsp|rtsps|http|https|rtmp|udp|tcp)://", url, re.I):
            raise ValueError("Kamera adresi rtsp://... ya da http://... ile başlamalı")
        if url.lower().startswith("rtsp"):
            inp += ["-rtsp_transport", "tcp"]
        inp += ["-fflags", "+genpts", "-i", url]
    elif t == "test":
        w, h = (w or 1280), (h or 720)
        inp = ["-re", "-f", "lavfi", "-i", "testsrc2=size=%dx%d:rate=%d" % (w, h, fps)]
        audio_ok = False
    else:
        raise ValueError("Bilinmeyen kaynak türü")

    gop = max(2, fps * SEG_SECONDS)
    cmd = [CFG["ffmpeg"], "-hide_banner", "-loglevel", "warning", "-y"] + inp
    cmd += ["-map", "0:v:0"]
    if t == "ip" or (t == "capture" and audio_ok):
        cmd += ["-map", "0:a:0?"]
    if codec == "h264":
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p"]
        if p.get("bitrate"):
            br = int(p["bitrate"])
            cmd += ["-b:v", str(br), "-maxrate", str(br), "-bufsize", str(br * 2)]
        else:
            cmd += ["-crf", "23", "-maxrate", "10M", "-bufsize", "20M"]
        s.ext = "mp4"
        fmt_opts = ["-segment_format", "mp4", "-segment_format_options", "movflags=+frag_keyframe+empty_moov+default_base_moof"]
        acodec = ["-c:a", "aac", "-b:a", "128k"]
    else:  # geliştirme/deneme: vp8 + webm
        cmd += ["-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "2M", "-pix_fmt", "yuv420p"]
        s.ext = "webm"
        fmt_opts = ["-segment_format", "webm"]
        acodec = ["-c:a", "libopus", "-b:a", "96k"]
    cmd += ["-g", str(gop), "-keyint_min", str(gop), "-sc_threshold", "0",
            "-force_key_frames", "expr:gte(t,n_forced*%d)" % SEG_SECONDS]
    cmd += acodec
    cmd += ["-f", "segment", "-segment_time", str(SEG_SECONDS)] + fmt_opts
    cmd += ["-segment_list", s.listfile, "-segment_list_type", "csv", "-segment_list_flags", "live",
            "-reset_timestamps", "1", os.path.join(s.segdir, "seg%05d." + s.ext)]
    return cmd


def start_session(p):
    with LOCK:
        cur = STATE["sess"]
        if running(cur):
            raise ValueError("Zaten bir yayın sürüyor. Önce onu durdur.")
        if not CFG["ffmpeg"]:
            raise ValueError("ffmpeg bulunamadı. ffmpeg.exe dosyasını saha-yayin.py'nin yanına koy.")
        s = Session()
        s.key = "".join(random.SystemRandom().choice(string.ascii_lowercase + string.digits) for _ in range(10))
        s.type = p.get("type")
        s.started = time.time()
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        s.dir = os.path.join(CFG["out"], "%s_%s" % (stamp, s.type))
        s.segdir = os.path.join(s.dir, "seg")
        os.makedirs(s.segdir, exist_ok=True)
        s.listfile = os.path.join(s.dir, "list.csv")
        s.err = collections.deque(maxlen=40)
        s.merged = None
        s.stopped = False
        s.ext = "mp4"
        cmd = build_cmd(p, s)
        kw = {}
        if IS_WIN:
            kw["creationflags"] = 0x08000000
        s.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, **kw)

        def pump():
            for line in iter(s.proc.stderr.readline, b""):
                s.err.append(line.decode("utf-8", "replace").rstrip())
        threading.Thread(target=pump, daemon=True).start()
        STATE["sess"] = s
    # ilk saniyelerde hata verip kapanırsa kullanıcıya söyle
    for _ in range(25):
        time.sleep(0.2)
        if s.proc.poll() is not None:
            tail = "\n".join(list(s.err)[-8:])
            raise ValueError("ffmpeg başlatılamadı:\n" + tail)
    return s


def merge_session(s):
    segs = read_segments(s)
    if not segs:
        return None
    lst = os.path.join(s.dir, "concat.txt")
    with open(lst, "w", encoding="utf-8") as f:
        for x in segs:
            f.write("file 'seg/%s'\n" % x[0])
    out = os.path.join(s.dir, "kayit." + s.ext)
    kw = {"cwd": s.dir}
    if IS_WIN:
        kw["creationflags"] = 0x08000000
    r = subprocess.run([CFG["ffmpeg"], "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
                        "-i", "concat.txt", "-c", "copy", "kayit." + s.ext],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **kw)
    if r.returncode == 0 and os.path.isfile(out):
        return out
    s.err.append(r.stdout.decode("utf-8", "replace")[-300:])
    return None


def stop_session():
    with LOCK:
        s = STATE["sess"]
    if not s:
        raise ValueError("Çalışan yayın yok")
    s.stopped = True
    if running(s):
        try:
            s.proc.stdin.write(b"q")
            s.proc.stdin.flush()
        except Exception:
            pass
        try:
            s.proc.wait(timeout=12)
        except subprocess.TimeoutExpired:
            s.proc.terminate()
            try:
                s.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                s.proc.kill()
    if not s.merged:
        s.merged = merge_session(s)
    return s


def status():
    s = STATE["sess"]
    if not s:
        return {"session": None}
    segs = read_segments(s)
    return {"session": {
        "key": s.key, "type": s.type, "running": running(s), "segments": len(segs),
        "seconds": segs[-1][2] if segs else 0, "dir": s.dir, "merged": s.merged,
        "error": "\n".join(list(s.err)[-6:]) if (not running(s) and not s.stopped and s.proc.returncode not in (0, None)) else "",
        "started": s.started}}


VIEWER = r"""<!DOCTYPE html>
<html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>SAHA Yayın</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#000;color:#eee;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow:hidden}
#app{display:flex;flex-direction:column;height:100%;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
#stage{position:relative;flex:1;min-height:0;background:#000}
video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;opacity:0}
video.on{opacity:1}
#badge{position:absolute;left:10px;top:10px;padding:4px 10px;border-radius:999px;background:rgba(0,0,0,.6);font-size:14px}
#badge.live{color:#ff5a5a}
#msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;font-size:18px;color:#bbb}
#bar{background:#111;padding:8px 10px 10px;border-top:1px solid #333}
#sk{width:100%;height:36px;margin:0 0 4px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:center}
button{font:inherit;font-size:16px;color:#eee;background:#262626;border:1px solid #444;border-radius:10px;min-height:46px;min-width:56px;padding:6px 12px;touch-action:manipulation}
button.on{background:#0c447c;border-color:#b5d4f4}
button.lv{background:#5a1616;border-color:#ff7a7a}
#tm{font-variant-numeric:tabular-nums;font-size:15px;min-width:120px;text-align:center;color:#ccc}
</style></head><body>
<div id="app">
<div id="stage"><video id="v0" playsinline muted></video><video id="v1" playsinline muted></video><div id="badge"></div><div id="msg">Bağlanıyor...</div></div>
<div id="bar">
<input type="range" id="sk" min="0" max="1" step="0.1" value="0" aria-label="Konum">
<div class="row">
<button id="b30">-30 sn</button><button id="b10">-10 sn</button><button id="pp">Duraklat</button><button id="f10">+10 sn</button><button id="f30">+30 sn</button>
<span id="tm">00:00 / 00:00</span>
<button id="sp">1x</button><button id="lv" class="lv">Canlı</button><button id="mu">Ses kapalı</button>
</div></div></div>
<script>
var BASE=location.pathname.replace(/[^\/]*$/,"");
var $=function(i){return document.getElementById(i);};
var vids=[$("v0"),$("v1")],cur=0,curIdx=-1,segs=[],total=0,running=true,playing=true,rate=1,first=true,dragging=false,pendingNext=false,muted=true,nextIdx=-1,lastErr=0;
function fmt(s){s=Math.max(0,Math.floor(s));var h=Math.floor(s/3600),m=Math.floor(s%3600/60),c=s%60;function p(n){return (n<10?"0":"")+n;}return (h?h+":":"")+p(m)+":"+p(c);}
function pos(){if(curIdx<0||!segs[curIdx])return 0;return segs[curIdx].s+vids[cur].currentTime;}
function findSeg(p){for(var i=segs.length-1;i>=0;i--){if(p>=segs[i].s)return i;}return 0;}
function show(i){vids[0].classList.toggle("on",i===0);vids[1].classList.toggle("on",i===1);}
function setSrc(v,i){v.src=BASE+"s/"+segs[i].n;v.playbackRate=rate;v.muted=muted;v.preload="auto";}
function loadAt(i,o){
if(!segs[i])return;
var v=vids[cur],o2=Math.max(0,o||0);
curIdx=i;pendingNext=false;nextIdx=-1;
vids[1-cur].pause();
v.onloadedmetadata=function(){try{v.currentTime=o2;}catch(e){}};
setSrc(v,i);
v.load();
show(cur);
if(playing){var p=v.play();if(p&&p.catch)p.catch(function(){});}
prepNext();
$("msg").style.display="none";
}
function prepNext(){
var n=curIdx+1;
if(!segs[n]){nextIdx=-1;return;}
var o=vids[1-cur];
nextIdx=n;
setSrc(o,n);o.load();
}
function swap(){
var n=curIdx+1;
if(!segs[n]){pendingNext=true;return;}
var o=vids[1-cur];
if(nextIdx!==n){setSrc(o,n);o.load();nextIdx=n;}
if(o.readyState<2){pendingNext=true;return;}
pendingNext=false;
var old=vids[cur];
try{o.currentTime=0;}catch(e){}
var p=o.play();if(p&&p.catch)p.catch(function(){});
show(1-cur);
old.pause();
cur=1-cur;curIdx=n;
prepNext();
}
function tick(){
var v=vids[cur];
if(curIdx<0){return;}
var d=v.duration,t=v.currentTime;
if(isFinite(d)&&d>0&&(d-t)<0.15&&playing)swap();
else if(pendingNext&&segs[curIdx+1])swap();
ui();
}
setInterval(tick,80);
function ui(){
var p=pos();
if(!dragging){$("sk").max=Math.max(total,1);$("sk").value=p;}
var live=running&&(total-p)<5;
var b=$("badge");
b.className=live?"live":"";
b.textContent=live?"● CANLI":(running?"Geride "+fmt(total-p):"Kayıt: "+fmt(p)+" / "+fmt(total));
$("tm").textContent=fmt(dragging?+$("sk").value:p)+" / "+fmt(total);
$("pp").textContent=playing?"Duraklat":"Oynat";
$("lv").style.display=running?"":"none";
$("lv").classList.toggle("on",live);
}
function seek(p){
if(!segs.length)return;
p=Math.min(Math.max(0,p),Math.max(0,total-0.05));
var i=findSeg(p);
loadAt(i,p-segs[i].s);
}
function live(){if(!segs.length)return;var i=segs.length-1;playing=true;loadAt(i,0);}
function poll(){
fetch(BASE+"list.json?_="+Date.now(),{cache:"no-store"}).then(function(r){if(!r.ok)throw 0;return r.json();}).then(function(j){
segs=j.segs.map(function(x){return {n:x[0],s:x[1],e:x[2]};});
total=j.total||0;running=!!j.running;
if(first&&segs.length){first=false;if(running)live();else loadAt(0,0);}
else if(first){$("msg").textContent=running?"Yayın başlıyor, birkaç saniye bekle...":"Kayıt bulunamadı";}
if(!first&&curIdx>=0&&pendingNext&&segs[curIdx+1])swap();
if(!first&&curIdx>=0&&nextIdx<0&&segs[curIdx+1])prepNext();
ui();
}).catch(function(){ $("badge").textContent="Bağlantı yok, yeniden deniyor..."; });
}
setInterval(poll,1500);poll();
$("pp").onclick=function(){playing=!playing;var v=vids[cur];if(playing){var p=v.play();if(p&&p.catch)p.catch(function(){});}else v.pause();ui();};
$("b10").onclick=function(){seek(pos()-10);};
$("f10").onclick=function(){seek(pos()+10);};
$("b30").onclick=function(){seek(pos()-30);};
$("f30").onclick=function(){seek(pos()+30);};
$("lv").onclick=live;
$("sp").onclick=function(){var l=[1,1.5,2,0.5],i=l.indexOf(rate);rate=l[(i+1)%l.length];vids[0].playbackRate=rate;vids[1].playbackRate=rate;$("sp").textContent=(rate===0.5?"0,5":String(rate).replace(".",","))+"x";};
$("mu").onclick=function(){muted=!muted;vids[0].muted=muted;vids[1].muted=muted;$("mu").textContent=muted?"Ses kapalı":"Ses açık";$("mu").classList.toggle("on",!muted);};
$("sk").addEventListener("input",function(){dragging=true;ui();});
$("sk").addEventListener("change",function(){dragging=false;seek(+$("sk").value);});
window.__saha={pos:pos,seek:seek,live:live,state:function(){return {curIdx:curIdx,cur:cur,total:total,segs:segs.length,running:running,playing:playing,paused:vids[cur].paused,ready:vids[cur].readyState};}};
</script></body></html>
"""


# ======================= CONVERT: videoları birleştir / küçült =======================
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".mts", ".m2ts", ".ts", ".mpg", ".mpeg", ".wmv", ".m4v", ".flv", ".mxf", ".3gp", ".vob"}
JOBS = []
JOBQ = queue.Queue()
JOB_LOCK = threading.Lock()
WORKER = {"t": None}


def find_ffprobe():
    if CFG.get("ffprobe"):
        return CFG["ffprobe"]
    ff = CFG["ffmpeg"]
    if ff:
        cand = os.path.join(os.path.dirname(ff), "ffprobe.exe" if IS_WIN else "ffprobe")
        if os.path.isfile(cand):
            return cand
    return shutil.which("ffprobe")


def _fps(v):
    try:
        if "/" in str(v):
            a, b = str(v).split("/")
            return round(float(a) / float(b), 3) if float(b) else 0
        return round(float(v), 3)
    except Exception:
        return 0


def probe(path):
    if not os.path.isfile(path):
        raise ValueError("Dosya bulunamadı: %s" % path)
    info = {"path": path, "name": os.path.basename(path), "size": os.path.getsize(path), "duration": 0.0,
            "vcodec": "", "width": 0, "height": 0, "fps": 0, "acodec": "", "asr": 0, "ach": 0, "audio": False}
    fp = find_ffprobe()
    done = False
    if fp:
        txt = run_capture([fp, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], timeout=60)
        try:
            j = json.loads(txt)
            info["duration"] = float((j.get("format") or {}).get("duration") or 0)
            for st in j.get("streams", []):
                if st.get("codec_type") == "video" and not info["vcodec"] and st.get("disposition", {}).get("attached_pic", 0) != 1:
                    info.update(vcodec=st.get("codec_name", ""), width=int(st.get("width") or 0), height=int(st.get("height") or 0),
                                fps=_fps(st.get("avg_frame_rate") or st.get("r_frame_rate")))
                    if not info["duration"]:
                        info["duration"] = float(st.get("duration") or 0)
                elif st.get("codec_type") == "audio" and not info["audio"]:
                    info.update(audio=True, acodec=st.get("codec_name", ""), asr=int(st.get("sample_rate") or 0), ach=int(st.get("channels") or 0))
            done = bool(info["vcodec"])
        except Exception:
            done = False
    if not done:
        txt = run_capture([CFG["ffmpeg"], "-hide_banner", "-i", path], timeout=60)
        m = re.search(r"Duration:\s*(\d+):(\d+):([\d.]+)", txt)
        if m:
            info["duration"] = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
        m = re.search(r"Video:\s*(\w+).*?,\s*(\d{2,5})x(\d{2,5})", txt)
        if m:
            info.update(vcodec=m.group(1), width=int(m.group(2)), height=int(m.group(3)))
        m = re.search(r"([\d.]+)\s*fps", txt)
        if m:
            info["fps"] = float(m.group(1))
        m = re.search(r"Audio:\s*(\w+).*?,\s*(\d+)\s*Hz,\s*(\w+)", txt)
        if m:
            info.update(audio=True, acodec=m.group(1), asr=int(m.group(2)), ach=1 if m.group(3) == "mono" else 2)
    if not info["vcodec"]:
        raise ValueError("Video okunamadı: %s" % os.path.basename(path))
    return info


def fs_roots():
    roots = []
    home = os.path.expanduser("~")
    for label, sub in (("Masaüstü", "Desktop"), ("Videolar", "Videos"), ("İndirilenler", "Downloads"), ("Belgeler", "Documents")):
        d = os.path.join(home, sub)
        if os.path.isdir(d):
            roots.append({"n": label, "p": d})
    if CFG.get("out") and os.path.isdir(CFG["out"]):
        roots.append({"n": "SAHA-Kayıtlar", "p": CFG["out"]})
    if IS_WIN:
        for c in "CDEFGHIJKLMNOPQRSTUVWXYZ":
            if os.path.exists(c + ":\\"):
                roots.append({"n": c + ":", "p": c + ":\\"})
    else:
        roots.append({"n": "/", "p": "/"})
    return roots


def fs_list(path):
    if not path:
        path = os.path.expanduser("~")
    path = os.path.abspath(path)
    if not os.path.isdir(path):
        raise ValueError("Klasör bulunamadı")
    ents = []
    try:
        for e in os.scandir(path):
            if e.name.startswith("."):
                continue
            try:
                if e.is_dir(follow_symlinks=True):
                    ents.append({"n": e.name, "d": True, "s": 0, "m": int(e.stat().st_mtime)})
                elif os.path.splitext(e.name)[1].lower() in VIDEO_EXT:
                    st = e.stat()
                    ents.append({"n": e.name, "d": False, "s": st.st_size, "m": int(st.st_mtime)})
            except OSError:
                continue
    except PermissionError:
        raise ValueError("Bu klasöre erişim izni yok")
    ents.sort(key=lambda x: (not x["d"], x["n"].lower()))
    parent = os.path.dirname(path.rstrip("\\/")) if os.path.dirname(path.rstrip("\\/")) != path else ""
    return {"path": path, "parent": parent, "entries": ents[:3000], "roots": fs_roots()}


def unique_out(dirpath, name):
    base = re.sub(r'[\\/:*?"<>|]+', "_", name or "").strip().rstrip(".") or "birlesik"
    if base.lower().endswith(".mp4"):
        base = base[:-4]
    os.makedirs(dirpath, exist_ok=True)
    out = os.path.join(dirpath, base + ".mp4")
    n = 2
    while os.path.exists(out):
        out = os.path.join(dirpath, "%s (%d).mp4" % (base, n))
        n += 1
    return out


class Job:
    pass


def _even(n):
    n = int(round(n))
    return max(2, n - (n % 2))


def compatible(infos):
    a = infos[0]
    for b in infos[1:]:
        if (a["vcodec"], a["width"], a["height"], round(a["fps"], 2)) != (b["vcodec"], b["width"], b["height"], round(b["fps"], 2)):
            return False
        if a["audio"] != b["audio"]:
            return False
        if a["audio"] and (a["acodec"], a["asr"], a["ach"]) != (b["acodec"], b["asr"], b["ach"]):
            return False
    return True


def build_convert_cmd(job, mode):
    ff = CFG["ffmpeg"]
    base = [ff, "-y", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats"]
    infos = job.infos
    if mode == "copy":
        job.listfile = os.path.join(tempfile.gettempdir(), "saha-concat-%s.txt" % job.id)
        with open(job.listfile, "w", encoding="utf-8") as f:
            for i in infos:
                f.write("file '%s'\n" % i["path"].replace("\\", "/").replace("'", "'\\''"))
        return base + ["-f", "concat", "-safe", "0", "-i", job.listfile, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy",
                       "-movflags", "+faststart", job.out]
    o = job.opts
    preset = {"hizli": "veryfast", "dengeli": "medium", "kucuk": "slow"}.get(o.get("speed"), "medium")
    crf = {"yuksek": 20, "dengeli": 24, "kucuk": 28}.get(o.get("quality"), 24)
    if o.get("forced_crf"):
        crf = o["forced_crf"]
    total = job.total
    venc = ["-c:v", "libx264", "-preset", preset, "-pix_fmt", "yuv420p"]
    audio_on = o.get("audio", True) and any(i["audio"] for i in infos)
    abps = 128000
    if o.get("quality") == "hedef" and not o.get("forced_crf"):
        tgt = float(o.get("target_gb") or 0) * (1024 ** 3)
        if tgt <= 0 or total <= 0:
            raise ValueError("Hedef boyut geçersiz")
        vb = int(tgt * 8 / total * 0.95 - (abps if audio_on else 0))
        if vb < 150000:
            raise ValueError("Hedef boyut bu süre için çok küçük. Daha büyük bir hedef seç.")
        venc += ["-b:v", str(vb), "-maxrate", str(int(vb * 1.4)), "-bufsize", str(vb * 2)]
    else:
        venc += ["-crf", str(crf)]
    a0 = infos[0]
    th = int(o.get("height") or 0)
    if th and a0["height"] and th >= a0["height"] and len(infos) == 1:
        th = 0
    W = _even(a0["width"])
    H = _even(a0["height"])
    if th:
        H = _even(th)
        W = _even(th * a0["width"] / max(1, a0["height"]))
    fps = 30 if o.get("fps30") else 0
    if len(infos) == 1:
        vf = []
        if th:
            vf.append("scale=-2:%d" % H)
        if fps and a0["fps"] > 30.5:
            vf.append("fps=30")
        cmd = base + ["-i", infos[0]["path"], "-map", "0:v:0"]
        if audio_on:
            cmd += ["-map", "0:a:0?"]
        if vf:
            cmd += ["-vf", ",".join(vf)]
        cmd += venc
        cmd += ["-c:a", "aac", "-b:a", "128k"] if audio_on else ["-an"]
        return cmd + ["-movflags", "+faststart", job.out]
    tf = fps or (round(a0["fps"]) or 30)
    parts, cat = [], []
    for k, i in enumerate(infos):
        parts.append("[%d:v:0]scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=%d,format=yuv420p[v%d]" % (k, W, H, W, H, tf, k))
        cat.append("[v%d]" % k)
        if audio_on:
            if i["audio"]:
                parts.append("[%d:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a%d]" % (k, k))
            else:
                parts.append("anullsrc=r=48000:cl=stereo,atrim=0:%.3f,asetpts=PTS-STARTPTS[a%d]" % (max(0.1, i["duration"]), k))
            cat.append("[a%d]" % k)
    parts.append("%sconcat=n=%d:v=1:a=%d[v]%s" % ("".join(cat), len(infos), 1 if audio_on else 0, "[a]" if audio_on else ""))
    cmd = base
    for i in infos:
        cmd += ["-i", i["path"]]
    cmd += ["-filter_complex", ";".join(parts), "-map", "[v]"]
    if audio_on:
        cmd += ["-map", "[a]"]
    cmd += venc
    cmd += ["-c:a", "aac", "-b:a", "128k"] if audio_on else ["-an"]
    return cmd + ["-movflags", "+faststart", job.out]


def run_one(job, mode):
    cmd = build_convert_cmd(job, mode)
    kw = {}
    if IS_WIN:
        kw["creationflags"] = 0x08000000
    job.err = collections.deque(maxlen=30)
    job.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, **kw)

    def pump():
        for line in iter(job.proc.stderr.readline, b""):
            job.err.append(line.decode("utf-8", "replace").rstrip())
    threading.Thread(target=pump, daemon=True).start()
    t0 = time.time()
    for raw in iter(job.proc.stdout.readline, b""):
        line = raw.decode("utf-8", "replace").strip()
        if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
            try:
                us = int(line.split("=", 1)[1])
                if job.total > 0:
                    job.pct = max(0.0, min(99.9, us / 1e6 / job.total * 100))
                    el = time.time() - t0
                    if job.pct > 0.5 and el > 2:
                        job.eta = el * (100 - job.pct) / job.pct
            except ValueError:
                pass
        elif line.startswith("speed="):
            job.speed = line.split("=", 1)[1]
    job.proc.wait()
    return job.proc.returncode


def worker():
    while True:
        job = JOBQ.get()
        if job.state == "canceled":
            continue
        job.state = "running"
        job.started = time.time()
        try:
            rc = run_one(job, job.mode)
            if job.state == "canceled":
                pass
            elif rc != 0 and job.mode == "copy":
                job.note = "Doğrudan birleştirme olmadı, yüksek kalitede yeniden kodlanıyor."
                job.opts = dict(job.opts, forced_crf=18, speed="hizli", audio=True)
                job.mode = "encode"
                job.pct, job.eta = 0.0, None
                rc = run_one(job, "encode")
            if job.state != "canceled":
                if rc == 0 and os.path.isfile(job.out):
                    job.state = "done"
                    job.pct = 100.0
                    job.out_size = os.path.getsize(job.out)
                else:
                    job.state = "error"
                    job.error = "\n".join(list(job.err)[-6:]) or "ffmpeg hata verdi"
        except Exception as e:
            job.state = "error"
            job.error = str(e)
        finally:
            job.finished = time.time()
            try:
                if getattr(job, "listfile", None) and os.path.isfile(job.listfile):
                    os.remove(job.listfile)
            except OSError:
                pass
            if job.state in ("error", "canceled") and os.path.isfile(job.out):
                try:
                    os.remove(job.out)
                except OSError:
                    pass


def convert_start(p):
    if not CFG["ffmpeg"]:
        raise ValueError("ffmpeg bulunamadı. ffmpeg.exe dosyasını saha-yayin.py'nin yanına koy.")
    paths = p.get("inputs") or []
    if not isinstance(paths, list) or not paths:
        raise ValueError("Önce video ekle")
    for x in paths:
        if not isinstance(x, str) or not os.path.isfile(x) or os.path.splitext(x)[1].lower() not in VIDEO_EXT:
            raise ValueError("Geçersiz dosya: %s" % x)
    infos = [probe(x) for x in paths]
    job = Job()
    job.id = "".join(random.SystemRandom().choice(string.ascii_lowercase + string.digits) for _ in range(8))
    job.infos = infos
    job.total = sum(i["duration"] for i in infos)
    job.in_size = sum(i["size"] for i in infos)
    mode = p.get("mode", "encode")
    if len(infos) == 1:
        mode = "encode"
    job.note = ""
    if mode == "copy" and not compatible(infos):
        mode = "encode"
        p = dict(p, quality="yuksek", speed="hizli", audio=True)
        job.note = "Dosyalar aynı biçimde olmadığı için yüksek kalitede yeniden kodlanacak."
    job.mode = mode
    job.opts = {"quality": p.get("quality", "dengeli"), "speed": p.get("speed", "dengeli"), "height": p.get("height", 0),
                "fps30": bool(p.get("fps30")), "audio": p.get("audio", True) is not False, "target_gb": p.get("target_gb")}
    where = p.get("where", "source")
    outdir = os.path.dirname(paths[0]) if where == "source" else os.path.join(CFG["out"], "convert")
    job.out = unique_out(outdir, p.get("name") or "birlesik")
    try:
        free = shutil.disk_usage(outdir).free
        need = job.in_size * 1.03 if mode == "copy" else 500 * 1024 * 1024
        if free < need:
            raise ValueError("Diskte yeterli yer yok (%.1f GB boş)." % (free / 1024 ** 3))
    except OSError:
        pass
    if mode == "encode" and job.opts["quality"] == "hedef":
        build_convert_cmd(job, "encode")  # hedef boyut geçerli mi, şimdi anla
    job.state, job.pct, job.eta, job.speed, job.error, job.out_size, job.started, job.finished = "queued", 0.0, None, "", "", 0, 0, 0
    job.err = collections.deque(maxlen=30)
    job.proc = None
    with JOB_LOCK:
        JOBS.append(job)
        if WORKER["t"] is None:
            WORKER["t"] = threading.Thread(target=worker, daemon=True)
            WORKER["t"].start()
    JOBQ.put(job)
    return job


def job_json(j):
    return {"id": j.id, "state": j.state, "pct": round(j.pct, 1), "eta": j.eta, "speed": j.speed, "note": j.note,
            "mode": j.mode, "out": j.out, "in_size": j.in_size, "out_size": j.out_size, "total": j.total,
            "files": [i["name"] for i in j.infos], "error": j.error}


def cancel_job(jid):
    for j in JOBS:
        if j.id == jid:
            if j.state in ("queued", "running"):
                j.state = "canceled"
                if j.proc and j.proc.poll() is None:
                    j.proc.terminate()
            return j
    raise ValueError("İşlem bulunamadı")


def reveal(path):
    path = os.path.abspath(path)
    if IS_WIN:
        subprocess.Popen(["explorer", "/select,", path])
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", path])
    return True


def origin_ok(origin):
    if not origin:
        return True
    return origin == "null" or re.match(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$", origin) is not None


class Handler(BaseHTTPRequestHandler):
    server_version = "SAHAYayin/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    # ---- yardımcılar
    def cors(self):
        o = self.headers.get("Origin")
        if o and origin_ok(o):
            self.send_header("Access-Control-Allow-Origin", o)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Saha")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def send_bytes(self, code, data, ctype, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.cors()
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_json(self, obj, code=200):
        self.send_bytes(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def is_local(self):
        return self.client_address[0] in ("127.0.0.1", "::1", "::ffff:127.0.0.1")

    def api_guard(self):
        if not self.is_local():
            self.send_json({"error": "Bu işlem sadece yayını başlatan bilgisayardan yapılabilir"}, 403)
            return False
        o = self.headers.get("Origin")
        if o and not origin_ok(o):
            self.send_json({"error": "İzin verilmeyen kaynak"}, 403)
            return False
        if self.command == "POST" and self.headers.get("X-Saha") != "1":
            self.send_json({"error": "Eksik başlık"}, 403)
            return False
        return True

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > 65536:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    # ---- yöntemler
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.cors()
        self.end_headers()

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/ping":
            if not self.api_guard():
                return
            return self.send_json({"ok": True, "name": "SAHA Yayın", "version": VERSION, "ffmpeg": bool(CFG["ffmpeg"]),
                                   "windows": IS_WIN, "port": CFG["port"]})
        if path == "/api/devices":
            if not self.api_guard():
                return
            return self.send_json(list_devices())
        if path == "/api/info":
            if not self.api_guard():
                return
            d = status()
            d.update({"ips": lan_ips(), "port": CFG["port"]})
            return self.send_json(d)
        if path == "/api/status":
            if not self.api_guard():
                return
            return self.send_json(status())
        if path == "/api/fs":
            if not self.api_guard():
                return
            q = self.path.split("?", 1)[1] if "?" in self.path else ""
            from urllib.parse import parse_qs
            try:
                return self.send_json(fs_list((parse_qs(q).get("path") or [""])[0]))
            except ValueError as e:
                return self.send_json({"error": str(e)}, 400)
        if path == "/api/convert/jobs":
            if not self.api_guard():
                return
            return self.send_json({"jobs": [job_json(j) for j in JOBS][-30:]})
        m = re.match(r"^/v/([a-z0-9]{10})/(.*)$", path)
        if m:
            return self.viewer(m.group(1), m.group(2))
        if path == "/":
            return self.send_bytes(200, "SAHA Yayın çalışıyor.".encode("utf-8"), "text/plain; charset=utf-8")
        self.send_bytes(404, b"Bulunamadi", "text/plain")

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if not self.api_guard():
            return
        try:
            if path == "/api/start":
                s = start_session(self.body())
                return self.send_json({"ok": True, "key": s.key})
            if path == "/api/stop":
                s = stop_session()
                return self.send_json({"ok": True, "dir": s.dir, "merged": s.merged})
            if path == "/api/probe":
                b = self.body()
                items, errs = [], []
                for x in (b.get("paths") or [])[:50]:
                    try:
                        items.append(probe(x))
                    except ValueError as e:
                        errs.append(str(e))
                return self.send_json({"items": items, "errors": errs})
            if path == "/api/convert/start":
                return self.send_json({"ok": True, "job": job_json(convert_start(self.body()))})
            if path == "/api/convert/cancel":
                return self.send_json({"ok": True, "job": job_json(cancel_job(self.body().get("id")))})
            if path == "/api/reveal":
                p = self.body().get("path") or ""
                if os.path.exists(p):
                    reveal(p)
                return self.send_json({"ok": True})
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)
        except Exception as e:
            return self.send_json({"error": "Beklenmeyen hata: %s" % e}, 500)
        self.send_bytes(404, b"Bulunamadi", "text/plain")

    # ---- izleyici (tablet)
    def viewer(self, key, rest):
        s = STATE["sess"]
        if not s or s.key != key:
            return self.send_bytes(404, "Yayın bulunamadı. Yeni QR kodu okut.".encode("utf-8"), "text/plain; charset=utf-8")
        if rest in ("", "index.html"):
            return self.send_bytes(200, VIEWER.encode("utf-8"), "text/html; charset=utf-8")
        if rest == "list.json":
            segs = read_segments(s)
            return self.send_json({"segs": segs, "total": segs[-1][2] if segs else 0, "running": running(s)})
        m = re.match(r"^s/(seg\d{5}\.(mp4|webm))$", rest)
        if m:
            return self.send_file(os.path.join(s.segdir, m.group(1)), "video/mp4" if m.group(2) == "mp4" else "video/webm")
        self.send_bytes(404, b"Bulunamadi", "text/plain")

    def send_file(self, fp, ctype):
        try:
            size = os.path.getsize(fp)
            f = open(fp, "rb")
        except OSError:
            return self.send_bytes(404, b"Bulunamadi", "text/plain")
        with f:
            start, end, code = 0, size - 1, 200
            rng = self.headers.get("Range")
            if rng:
                m = re.match(r"bytes=(\d*)-(\d*)", rng)
                if m and (m.group(1) or m.group(2)):
                    if m.group(1):
                        start = int(m.group(1))
                        if m.group(2):
                            end = min(int(m.group(2)), size - 1)
                    else:
                        start = max(0, size - int(m.group(2)))
                    if start > end or start >= size:
                        self.send_response(416)
                        self.send_header("Content-Range", "bytes */%d" % size)
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return
                    code = 206
            length = end - start + 1
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", "max-age=3600")
            if code == 206:
                self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
            self.end_headers()
            if self.command == "HEAD":
                return
            f.seek(start)
            left = length
            try:
                while left > 0:
                    chunk = f.read(min(65536, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass


def main():
    ap = argparse.ArgumentParser(description="SAHA Yayın")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--ffmpeg", default=None, help="ffmpeg yolu (varsayılan: yanındaki ffmpeg.exe ya da PATH)")
    ap.add_argument("--out", default=os.path.join(HERE, "SAHA-Kayitlar"), help="kayıt klasörü")
    ap.add_argument("--codec", default="h264", choices=["h264", "vp8"], help="vp8 sadece deneme içindir")
    a = ap.parse_args()
    CFG.update(ffmpeg=find_ffmpeg(a.ffmpeg), out=a.out, codec=a.codec, port=a.port)
    os.makedirs(a.out, exist_ok=True)
    try:
        srv = ThreadingHTTPServer(("0.0.0.0", a.port), Handler)
    except OSError as e:
        print("Port %d açılamadı (%s). Başka bir SAHA Yayın açık olabilir." % (a.port, e))
        sys.exit(1)
    srv.daemon_threads = True
    print("=" * 60)
    print(" SAHA Yayın %s çalışıyor" % VERSION)
    print(" ffmpeg: %s" % (CFG["ffmpeg"] or "BULUNAMADI (ffmpeg.exe'yi bu dosyanın yanına koy)"))
    print(" Kayıtlar: %s" % a.out)
    ips = lan_ips()
    print(" Bu bilgisayarın ağ adresleri: %s" % (", ".join(ips) if ips else "yok (Wi-Fi bağlı mı?)"))
    print(" SAHA uygulamasında VIDEO CAPTURE ve CONVERT sekmeleri bu programla çalışır.")
    print(" ffprobe: %s" % (find_ffprobe() or "yok (ffmpeg ile devam eder)"))
    print(" Kapatmak için bu pencerede Ctrl+C bas.")
    print("=" * 60)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        s = STATE["sess"]
        if s and running(s):
            print("Yayın durduruluyor...")
            try:
                stop_session()
            except Exception:
                pass
        srv.server_close()


if __name__ == "__main__":
    main()
