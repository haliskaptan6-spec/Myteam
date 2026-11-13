/* ═══════════════════════════════════════════════════════════
   BAYB Streamer — Frontend Application Logic
   Pure browser-based: uses getUserMedia + MediaRecorder
   ═══════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
    /* ─── Helpers ────────────────────────────────────────── */
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => document.querySelectorAll(s);

    /* ─── DOM ────────────────────────────────────────────── */
    const statusBadge    = $('#statusBadge');
    const statusText     = statusBadge.querySelector('.status-text');
    const videoPreview   = $('#videoPreview');
    const videoOverlay   = $('#videoOverlay');
    const liveBadge      = $('#liveBadge');
    const resBadge       = $('#resBadge');
    const fullscreenBtn  = $('#fullscreenBtn');

    const deviceSelect     = $('#deviceSelect');
    const resolutionSelect = $('#resolutionSelect');
    const fpsSelect        = $('#fpsSelect');
    const refreshBtn       = $('#refreshDevices');
    const streamUrlInput   = $('#streamUrl');
    const copyUrlBtn       = $('#copyUrlBtn');
    const openUrlBtn       = $('#openUrlBtn');
    const startBtn         = $('#startBtn');
    const qrCanvas         = $('#qrCanvas');
    const qrContainer      = $('#qrContainer');

    // Network tab
    const localIpEl        = $('#localIp');
    const portNumEl        = $('#portNum');
    const netStatusEl      = $('#netStreamStatus');
    const networkUrlInput  = $('#networkStreamUrl');
    const copyNetUrlBtn    = $('#copyNetUrlBtn');
    const networkQrCanvas  = $('#networkQrCanvas');
    const networkQrContainer = $('#networkQrContainer');
    const remoteUrlInput   = $('#remoteStreamUrl');
    const connectBtn       = $('#connectRemoteBtn');
    const disconnectBtn    = $('#disconnectRemoteBtn');
    const remoteVideo      = $('#remoteVideo');
    const remoteOverlay    = $('#remoteOverlay');

    const toast        = $('#toast');
    const toastMessage = $('#toastMessage');
    const toastIcon    = $('#toastIcon');

    /* ─── State ──────────────────────────────────────────── */
    let isStreaming = false;
    let localStream = null;
    let mediaRecorder = null;
    let recordedChunks = [];
    let streamUrl = '';
    let remoteHls = null;
    let toastTimer = null;
    let localIP = '';

    /* ─── Init ───────────────────────────────────────────── */
    init();

    async function init() {
        await enumerateDevices();
        detectLocalIP();
        setupTabs();
        setupDeviceToggle();
        setupButtons();
    }

    /* ─── Enumerate Video Devices ────────────────────────── */
    async function enumerateDevices() {
        refreshBtn.classList.add('spinning');
        deviceSelect.innerHTML = '<option value="">Cihazlar aranıyor...</option>';

        try {
            // Request permission first (needed to see device labels)
            const tempStream = await navigator.mediaDevices.getUserMedia({ video: true });
            tempStream.getTracks().forEach(t => t.stop());

            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevices = devices.filter(d => d.kind === 'videoinput');

            deviceSelect.innerHTML = '';

            if (videoDevices.length === 0) {
                deviceSelect.innerHTML = '<option value="">Cihaz bulunamadı</option>';
            } else {
                deviceSelect.innerHTML = '<option value="">Cihaz seçin...</option>';
                videoDevices.forEach((dev, i) => {
                    const opt = document.createElement('option');
                    opt.value = dev.deviceId;
                    opt.textContent = dev.label || `Kamera ${i + 1}`;
                    deviceSelect.appendChild(opt);
                });
            }
        } catch (err) {
            console.error('Device enumeration error:', err);
            deviceSelect.innerHTML = '<option value="">Kamera erişimi reddedildi</option>';
            showToast('⚠ Kamera erişim izni gerekli', 'warn');
        }

        setTimeout(() => refreshBtn.classList.remove('spinning'), 400);
    }

    /* ─── Detect Local IP via WebRTC ─────────────────────── */
    function detectLocalIP() {
        localIpEl.textContent = 'Algılanıyor...';

        // Use RTCPeerConnection to discover local IP
        try {
            const rtc = new RTCPeerConnection({ iceServers: [] });
            rtc.createDataChannel('');
            rtc.createOffer().then(offer => rtc.setLocalDescription(offer));

            rtc.onicecandidate = (e) => {
                if (!e || !e.candidate || !e.candidate.candidate) return;
                const match = e.candidate.candidate.match(/(\d+\.\d+\.\d+\.\d+)/);
                if (match) {
                    localIP = match[1];
                    localIpEl.textContent = localIP;
                    portNumEl.textContent = window.location.port || '—';
                    rtc.close();
                }
            };

            // Fallback
            setTimeout(() => {
                if (!localIP) {
                    localIP = window.location.hostname || 'localhost';
                    localIpEl.textContent = localIP;
                }
            }, 3000);
        } catch (e) {
            localIP = window.location.hostname || 'localhost';
            localIpEl.textContent = localIP;
        }
    }

    /* ─── Tab Switching ──────────────────────────────────── */
    function setupTabs() {
        $$('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                $$('.tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                $$('.tab-content').forEach(tc => tc.classList.remove('active'));
                const id = tab.dataset.tab === 'local' ? 'tabContentLocal' : 'tabContentNetwork';
                $(`#${id}`).classList.add('active');
            });
        });
    }

    /* ─── Device Type Toggle (placeholder for IP camera) ── */
    function setupDeviceToggle() {
        // Currently only local device is supported
    }

    /* ─── Button Events ──────────────────────────────────── */
    function setupButtons() {
        refreshBtn.addEventListener('click', enumerateDevices);

        startBtn.addEventListener('click', () => {
            if (isStreaming) stopStream();
            else startStream();
        });

        copyUrlBtn.addEventListener('click', () => copyToClipboard(streamUrlInput.value));
        openUrlBtn.addEventListener('click', () => {
            if (streamUrlInput.value) window.open(streamUrlInput.value, '_blank');
        });
        copyNetUrlBtn.addEventListener('click', () => copyToClipboard(networkUrlInput.value));

        connectBtn.addEventListener('click', connectToRemote);
        disconnectBtn.addEventListener('click', disconnectRemote);

        fullscreenBtn.addEventListener('click', () => {
            const container = $('#videoContainer');
            if (!document.fullscreenElement) {
                container.requestFullscreen().catch(() => {});
            } else {
                document.exitFullscreen();
            }
        });
    }

    /* ─── Start Stream ───────────────────────────────────── */
    async function startStream() {
        const deviceId = deviceSelect.value;
        if (!deviceId) {
            showToast('⚠ Lütfen bir cihaz seçin', 'warn');
            deviceSelect.focus();
            return;
        }

        const [w, h] = resolutionSelect.value.split('x').map(Number);
        const fps = parseInt(fpsSelect.value);

        startBtn.disabled = true;
        startBtn.innerHTML = svgSpinner() + ' Başlatılıyor...';

        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    deviceId: { exact: deviceId },
                    width:  { ideal: w },
                    height: { ideal: h },
                    frameRate: { ideal: fps }
                },
                audio: false
            });

            // Attach to preview
            videoPreview.srcObject = localStream;
            await videoPreview.play();

            // Get actual track settings
            const settings = localStream.getVideoTracks()[0].getSettings();
            const actualW = settings.width || w;
            const actualH = settings.height || h;

            // Build stream URL (this page's address + params)
            const port = window.location.port || '80';
            const baseUrl = `http://${localIP || window.location.hostname}:${port}`;
            streamUrl = baseUrl;

            // Start recording (optional)
            startRecording();

            // Update UI
            isStreaming = true;
            updateUI(true, actualW, actualH);

            showToast('🎬 Yayın başlatıldı!', 'success');

        } catch (err) {
            console.error('Stream start error:', err);
            let msg = 'Kamera açılamadı';
            if (err.name === 'NotAllowedError') msg = 'Kamera izni reddedildi';
            else if (err.name === 'NotFoundError') msg = 'Seçilen cihaz bulunamadı';
            else if (err.name === 'OverconstrainedError') msg = 'Seçilen çözünürlük desteklenmiyor';
            showToast('⚠ ' + msg, 'warn');
            resetStartBtn();
        }
    }

    /* ─── Stop Stream ────────────────────────────────────── */
    function stopStream() {
        if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
            localStream = null;
        }

        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }

        videoPreview.srcObject = null;
        isStreaming = false;
        streamUrl = '';
        updateUI(false);
        showToast('⏹ Yayın durduruldu', 'info');
    }

    /* ─── MediaRecorder (for local recording) ────────────── */
    function startRecording() {
        if (!localStream) return;
        recordedChunks = [];

        try {
            const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
                ? 'video/webm;codecs=vp9'
                : 'video/webm';

            mediaRecorder = new MediaRecorder(localStream, {
                mimeType,
                videoBitsPerSecond: 4000000
            });

            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) recordedChunks.push(e.data);
            };

            mediaRecorder.onstop = () => {
                if (recordedChunks.length > 0) {
                    const blob = new Blob(recordedChunks, { type: 'video/webm' });
                    const url = URL.createObjectURL(blob);
                    // Auto-download
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `BAYB_${timestamp()}.webm`;
                    a.click();
                    URL.revokeObjectURL(url);
                }
            };

            mediaRecorder.start(1000); // chunk every second
        } catch (err) {
            console.warn('Recording not supported:', err);
        }
    }

    /* ─── Connect to Remote HLS Stream ───────────────────── */
    function connectToRemote() {
        const url = remoteUrlInput.value.trim();
        if (!url) {
            showToast('⚠ Lütfen bir yayın URL\'si girin', 'warn');
            remoteUrlInput.focus();
            return;
        }

        connectBtn.disabled = true;
        connectBtn.innerHTML = svgSpinner() + ' Bağlanıyor...';

        if (remoteHls) {
            remoteHls.destroy();
            remoteHls = null;
        }

        if (typeof Hls !== 'undefined' && Hls.isSupported()) {
            remoteHls = new Hls({
                liveSyncDurationCount: 2,
                liveMaxLatencyDurationCount: 5,
                liveDurationInfinity: true,
                enableWorker: true,
                lowLatencyMode: true
            });

            remoteHls.loadSource(url);
            remoteHls.attachMedia(remoteVideo);

            remoteHls.on(Hls.Events.MANIFEST_PARSED, () => {
                remoteVideo.play().catch(() => {});
                remoteOverlay.classList.add('hidden');
                disconnectBtn.classList.remove('hidden');
                connectBtn.innerHTML = '✓ Bağlı';
                showToast('✓ Uzak yayına bağlanıldı!', 'success');
            });

            remoteHls.on(Hls.Events.ERROR, (_, data) => {
                if (data.fatal) {
                    console.error('Remote HLS error:', data);
                    showToast('⚠ Yayına bağlanılamadı. URL\'yi kontrol edin.', 'warn');
                    resetConnectBtn();
                }
            });
        } else if (remoteVideo.canPlayType('application/vnd.apple.mpegurl')) {
            // Safari
            remoteVideo.src = url;
            remoteVideo.addEventListener('loadedmetadata', () => {
                remoteVideo.play();
                remoteOverlay.classList.add('hidden');
                disconnectBtn.classList.remove('hidden');
                connectBtn.innerHTML = '✓ Bağlı';
            }, { once: true });
        } else {
            showToast('⚠ HLS desteklenmiyor', 'warn');
            resetConnectBtn();
        }
    }

    function disconnectRemote() {
        if (remoteHls) {
            remoteHls.destroy();
            remoteHls = null;
        }
        remoteVideo.src = '';
        remoteOverlay.classList.remove('hidden');
        disconnectBtn.classList.add('hidden');
        resetConnectBtn();
        showToast('Bağlantı kesildi', 'info');
    }

    function resetConnectBtn() {
        connectBtn.disabled = false;
        connectBtn.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
            Bağlan
        `;
    }

    /* ─── UI Updates ─────────────────────────────────────── */
    function updateUI(streaming, actualW, actualH) {
        if (streaming) {
            statusBadge.classList.add('streaming');
            statusText.textContent = 'Yayında';
            videoOverlay.classList.add('hidden');
            liveBadge.classList.remove('hidden');

            // Resolution badge
            const label = actualH >= 1080 ? '1080p' : actualH >= 720 ? '720p' : `${actualW}×${actualH}`;
            resBadge.textContent = label;
            resBadge.classList.remove('hidden');

            // Stream URL
            streamUrlInput.value = streamUrl;
            networkUrlInput.value = streamUrl;

            // QR codes
            generateQR(qrCanvas, qrContainer, streamUrl);
            generateQR(networkQrCanvas, networkQrContainer, streamUrl);

            // Network status
            netStatusEl.innerHTML = '<span class="status-indicator online"></span> Yayında';

            // Start button -> Stop
            startBtn.disabled = false;
            startBtn.classList.add('stop');
            startBtn.innerHTML = `
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="1"/>
                </svg>
                Durdur
            `;
        } else {
            statusBadge.classList.remove('streaming');
            statusText.textContent = 'Hazır';
            videoOverlay.classList.remove('hidden');
            liveBadge.classList.add('hidden');
            resBadge.classList.add('hidden');
            streamUrlInput.value = '';
            networkUrlInput.value = '';
            netStatusEl.innerHTML = '<span class="status-indicator offline"></span> Yayın yok';
            qrContainer.classList.remove('has-qr');
            networkQrContainer.classList.remove('has-qr');
            resetStartBtn();
        }
    }

    function resetStartBtn() {
        startBtn.disabled = false;
        startBtn.classList.remove('stop');
        startBtn.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            Başlat
        `;
    }

    /* ─── QR Code ────────────────────────────────────────── */
    function generateQR(canvas, container, text) {
        if (!text || typeof QRCode === 'undefined') return;
        QRCode.toCanvas(canvas, text, {
            width: 140,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' },
            errorCorrectionLevel: 'M'
        }, (err) => {
            if (!err) container.classList.add('has-qr');
        });
    }

    /* ─── Toast ──────────────────────────────────────────── */
    function showToast(message, type = 'success') {
        if (toastTimer) clearTimeout(toastTimer);

        const icons = { success: '✓', warn: '⚠', info: 'ℹ' };
        toastIcon.textContent = icons[type] || '✓';
        toastMessage.textContent = message;

        toast.className = 'toast';
        toast.classList.add(`toast-${type}`);

        requestAnimationFrame(() => {
            toast.classList.add('show');
        });

        toastTimer = setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.classList.add('hidden'), 300);
        }, 3500);
    }

    /* ─── Clipboard ──────────────────────────────────────── */
    function copyToClipboard(text) {
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => {
            showToast('URL panoya kopyalandı!', 'success');
        }).catch(() => {
            // Fallback
            const ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            showToast('URL panoya kopyalandı!', 'success');
        });
    }

    /* ─── Utility ────────────────────────────────────────── */
    function timestamp() {
        return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    }

    function svgSpinner() {
        return `<svg class="spin-anim" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;
    }
});
