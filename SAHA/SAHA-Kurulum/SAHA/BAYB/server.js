const express = require('express');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = 3000;

/* ─── Middleware ──────────────────────────────────────────── */
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ─── Stream directory ───────────────────────────────────── */
const streamDir = path.join(__dirname, 'stream');
if (!fs.existsSync(streamDir)) fs.mkdirSync(streamDir, { recursive: true });

// Serve HLS files with correct MIME types
app.use('/stream', express.static(streamDir, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.m3u8')) {
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Cache-Control', 'no-cache, no-store');
            res.setHeader('Access-Control-Allow-Origin', '*');
        } else if (filePath.endsWith('.ts')) {
            res.setHeader('Content-Type', 'video/mp2t');
            res.setHeader('Access-Control-Allow-Origin', '*');
        }
    }
}));

/* ─── State ──────────────────────────────────────────────── */
let ffmpegProcess = null;
let isStreaming = false;
let currentDevice = '';
let currentResolution = '';
let recordingFile = '';

/* ─── Helpers ────────────────────────────────────────────── */
function getNetworkInfo() {
    const interfaces = os.networkInterfaces();
    const addresses = [];
    for (const [name, nets] of Object.entries(interfaces)) {
        for (const net of nets) {
            if (net.family === 'IPv4' && !net.internal) {
                addresses.push({ name, address: net.address, mac: net.mac });
            }
        }
    }
    return addresses;
}

function cleanStreamDir() {
    if (fs.existsSync(streamDir)) {
        fs.readdirSync(streamDir).forEach(f => {
            try { fs.unlinkSync(path.join(streamDir, f)); } catch (e) { /* ignore */ }
        });
    }
}

/* ─── API: List DirectShow video devices (Windows) ───────── */
app.get('/api/devices', (req, res) => {
    exec('ffmpeg -list_devices true -f dshow -i dummy 2>&1', { encoding: 'utf8' }, (error, stdout, stderr) => {
        const output = (stdout || '') + (stderr || '');
        const devices = { video: [], audio: [] };
        let currentType = null;

        for (const line of output.split('\n')) {
            if (line.includes('DirectShow video devices')) currentType = 'video';
            else if (line.includes('DirectShow audio devices')) currentType = 'audio';
            else if (currentType) {
                const m = line.match(/"([^"]+)"/);
                if (m && !line.includes('Alternative name')) {
                    devices[currentType].push(m[1]);
                }
            }
        }
        res.json(devices);
    });
});

/* ─── API: Network information ───────────────────────────── */
app.get('/api/network', (req, res) => {
    const info = getNetworkInfo();
    const host = info.length > 0 ? info[0].address : 'localhost';
    res.json({
        addresses: info,
        port: PORT,
        hostname: os.hostname(),
        streamUrl: `http://${host}:${PORT}/stream/stream.m3u8`,
        webUrl: `http://${host}:${PORT}`
    });
});

/* ─── API: Start stream ──────────────────────────────────── */
app.post('/api/stream/start', (req, res) => {
    if (isStreaming) return res.status(400).json({ error: 'Yayın zaten çalışıyor' });

    const { device, resolution, recordingLocation } = req.body;
    if (!device) return res.status(400).json({ error: 'Cihaz seçilmedi' });

    cleanStreamDir();

    const [width, height] = (resolution || '1920x1080').split('x');
    currentDevice = device;
    currentResolution = resolution || '1920x1080';

    // FFmpeg args for HLS output
    const args = [
        '-f', 'dshow',
        '-video_size', `${width}x${height}`,
        '-framerate', '30',
        '-rtbufsize', '150M',
        '-i', `video=${device}`,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-b:v', '4000k',
        '-maxrate', '4500k',
        '-bufsize', '8000k',
        '-g', '60',
        '-sc_threshold', '0',
        '-f', 'hls',
        '-hls_time', '2',
        '-hls_list_size', '6',
        '-hls_flags', 'delete_segments+append_list+omit_endlist',
        '-hls_segment_filename', path.join(streamDir, 'seg_%05d.ts'),
        path.join(streamDir, 'stream.m3u8')
    ];

    // If recording location specified, add a second output
    if (recordingLocation) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        recordingFile = path.join(recordingLocation, `BAYB_${ts}.mp4`);

        // Insert recording output before HLS output using -map
        const inputEnd = args.indexOf('-c:v');
        const hlsArgs = args.splice(inputEnd);

        args.push(
            // Recording output
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
            '-f', 'mp4', '-movflags', '+faststart',
            recordingFile,
            // HLS output
            ...hlsArgs
        );
    }

    console.log(`\n🎬 Starting stream: ffmpeg ${args.join(' ')}\n`);

    ffmpegProcess = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let startupOutput = '';

    ffmpegProcess.stderr.on('data', (data) => {
        const msg = data.toString();
        startupOutput += msg;
        // Log only important lines
        if (msg.includes('frame=') || msg.includes('Error') || msg.includes('error')) {
            process.stdout.write(`  📹 ${msg}`);
        }
    });

    ffmpegProcess.on('error', (err) => {
        console.error('❌ FFmpeg error:', err.message);
        isStreaming = false;
        ffmpegProcess = null;
    });

    ffmpegProcess.on('close', (code) => {
        console.log(`\n⏹  FFmpeg exited (code ${code})`);
        isStreaming = false;
        ffmpegProcess = null;
    });

    isStreaming = true;

    const networkInfo = getNetworkInfo();
    const host = networkInfo.length > 0 ? networkInfo[0].address : 'localhost';

    res.json({
        success: true,
        streamUrl: `http://${host}:${PORT}/stream/stream.m3u8`,
        localUrl: `http://localhost:${PORT}/stream/stream.m3u8`,
        recording: recordingFile || null
    });
});

/* ─── API: Stop stream ───────────────────────────────────── */
app.post('/api/stream/stop', (req, res) => {
    if (ffmpegProcess) {
        // Graceful stop: send 'q' to FFmpeg stdin
        try { ffmpegProcess.stdin.write('q'); } catch (e) { /* ignore */ }
        setTimeout(() => {
            try { ffmpegProcess?.kill('SIGTERM'); } catch (e) { /* ignore */ }
            ffmpegProcess = null;
        }, 2000);
    }
    isStreaming = false;
    recordingFile = '';
    res.json({ success: true });
});

/* ─── API: Stream status ─────────────────────────────────── */
app.get('/api/stream/status', (req, res) => {
    res.json({
        isStreaming,
        device: currentDevice,
        resolution: currentResolution,
        recording: recordingFile,
        hlsReady: fs.existsSync(path.join(streamDir, 'stream.m3u8'))
    });
});

/* ─── API: Check if FFmpeg is available ──────────────────── */
app.get('/api/ffmpeg-check', (req, res) => {
    exec('ffmpeg -version', (error, stdout) => {
        if (error) {
            res.json({ installed: false, version: null });
        } else {
            const vLine = (stdout || '').split('\n')[0];
            res.json({ installed: true, version: vLine });
        }
    });
});

/* ─── Start Server ───────────────────────────────────────── */
app.listen(PORT, '0.0.0.0', () => {
    const net = getNetworkInfo();
    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║          🎥  BAYB Streamer v1.0              ║');
    console.log('╠══════════════════════════════════════════════╣');
    console.log(`║  Local:   http://localhost:${PORT}              ║`);
    if (net.length > 0) {
        const url = `http://${net[0].address}:${PORT}`;
        console.log(`║  Network: ${url.padEnd(33)}║`);
    }
    console.log('╚══════════════════════════════════════════════╝\n');
});
