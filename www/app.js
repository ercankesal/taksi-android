// Taksi Sürücü - Offline çalışan, native plugin entegreli versiyon
// Sunucu: Render'daki taksi-durak backend
const SERVER_URL = 'https://taksi-durak.onrender.com';
const SAVED_KEY = 'taksidurak_driver_v2';

let socket = null;
let myName = '', myPlate = '';
let myStatus = 'available';
let sentCount = 0;
let watchId = null;
let nativeMode = false;
let NativeGeolocation = null;

function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), 3000);
}

// Capacitor native köprüsünü algıla
async function detectNative() {
  try {
    // window.Capacitor Capacitor tarafından otomatik enjekte edilir
    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
      nativeMode = true;
      // BackgroundGeolocation plugin'i yüklü mü kontrol et
      // Capacitor plugin'leri window.Capacitor.Plugins altında olur
      if (window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundGeolocation) {
        NativeGeolocation = window.Capacitor.Plugins.BackgroundGeolocation;
        console.log('BackgroundGeolocation plugin hazır');
      } else if (window.Capacitor.Plugins && window.Capacitor.Plugins.Geolocation) {
        NativeGeolocation = window.Capacitor.Plugins.Geolocation;
        console.log('Geolocation plugin hazır');
      }
      return true;
    }
  } catch (e) {
    console.log('Native detect error:', e);
  }
  return false;
}

// localStorage yardımcıları (WebView içinde çalışır)
function loadSaved() {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (obj.name && obj.plate) return obj;
  } catch (e) {}
  return null;
}
function saveDriver(name, plate, status) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify({ name, plate, status })); } catch (e) {}
}

// Socket.IO benzeri minimal WebSocket istemcisi
class MiniSocket {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.handlers = {};
  }
  on(event, cb) { this.handlers[event] = cb; }
  connect() {
    return new Promise((resolve, reject) => {
      const wsUrl = this.url.replace('https://', 'wss://').replace('http://', 'ws://') + '/socket.io/?EIO=4&transport=websocket';
      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = 'arraybuffer';
      this.ws.onopen = () => {
        this.send('0{"sid":"' + Math.random().toString(36).slice(2,12) + '","upgrades":[],"pingInterval":25000,"pingTimeout":5000}');
        this.connected = true;
        this.updateUI('🟢 Bağlı', true);
        resolve();
      };
      this.ws.onclose = () => {
        this.connected = false;
        this.updateUI('❌ Kopuk, bekleniyor...', false);
        this.scheduleReconnect();
      };
      this.ws.onerror = (e) => {
        this.updateUI('❌ Hata', false);
        reject(e);
      };
      this.ws.onmessage = (e) => this.handle(e.data);
    });
  }
  send(data) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(data);
  }
  emit(event, data) {
    this.send('42' + JSON.stringify([event, data]));
  }
  handle(msg) {
    if (!msg) return;
    const t = msg[0];
    if (t === '2') this.send('3'); // ping -> pong
    else if (t === '4') {
      try {
        const [event, payload] = JSON.parse(msg.slice(1));
        if (this.handlers[event]) this.handlers[event](payload);
      } catch (e) {}
    }
  }
  updateUI(text, ok) {
    const el = document.getElementById('server-status');
    if (el) el.textContent = text;
  }
  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().then(() => {
        if (myName && myPlate) this.emit('driver:register', { name: myName, plate: myPlate });
        toast('Yeniden bağlandı');
      }).catch(() => this.scheduleReconnect());
    }, 5000);
  }
  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
  }
}

function sendLocation(lat, lng, speed, heading) {
  if (!socket || !socket.connected) return;
  socket.emit('driver:location', {
    lat, lng,
    speed: speed || 0,
    heading: heading || 0,
    status: myStatus
  });
  sentCount++;
  const el = document.getElementById('sent-count');
  if (el) el.textContent = sentCount;
  const dot = document.getElementById('gps-dot');
  if (dot) dot.classList.remove('off');
}

async function startGPS() {
  if (nativeMode && NativeGeolocation) {
    // Native plugin ile arka plan GPS
    try {
      // İzin iste
      if (NativeGeolocation.requestPermissions) {
        const perm = await NativeGeolocation.requestPermissions();
        if (perm && perm.location && perm.location !== 'granted') {
          toast('Konum izni verilmedi', true);
        }
      }
      // Dinle
      if (NativeGeolocation.addListener) {
        await NativeGeolocation.addListener('location', (loc) => {
          if (!loc) return;
          document.getElementById('gps-status').textContent = 'GPS Aktif (arka plan)';
          document.getElementById('my-coords').textContent = `${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}`;
          sendLocation(loc.latitude, loc.longitude, (loc.speed || 0) * 3.6, loc.heading || 0);
        });
      }
      // Başlat
      if (NativeGeolocation.start) {
        await NativeGeolocation.start({});
        toast('Arka plan GPS başlatıldı');
        return;
      }
    } catch (e) {
      console.error('Native GPS hatası:', e);
    }
  }

  // Fallback: Web Geolocation API
  if (!navigator.geolocation) {
    toast('GPS desteklenmiyor', true);
    return;
  }
  if (watchId !== null) return; // zaten çalışıyor
  document.getElementById('gps-status').textContent = 'GPS Aktif (web)';
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      document.getElementById('gps-status').textContent = 'GPS Aktif';
      document.getElementById('my-coords').textContent = `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`;
      sendLocation(pos.coords.latitude, pos.coords.longitude, (pos.coords.speed || 0) * 3.6, 0);
    },
    (err) => {
      let msg = 'GPS hatası';
      if (err.code === 1) msg = 'Konum izni reddedildi';
      else if (err.code === 2) msg = 'Konum alınamadı';
      else if (err.code === 3) msg = 'GPS zaman aşımı';
      toast(msg, true);
    },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000, distanceFilter: 0 }
  );
}

function stopGPS() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (nativeMode && NativeGeolocation && NativeGeolocation.stop) {
    NativeGeolocation.stop().catch(() => {});
  }
}

async function connectAndRegister() {
  socket = new MiniSocket(SERVER_URL);
  socket.on('driver:registered', () => {
    document.getElementById('register-card').classList.add('hidden');
    document.getElementById('active-card').classList.remove('hidden');
    document.getElementById('driver-display').textContent = `${myName} • ${myPlate}`;
    document.getElementById('my-status').textContent = myStatus === 'busy' ? '🔴 Meşgul' : '🟢 Müsait';
    startGPS();
    toast('Bağlantı kuruldu');
  });
  socket.on('driver:kicked', () => {
    toast('Yeni bağlantı açıldı, çıkılıyor', true);
    setTimeout(() => disconnectAll(), 2000);
  });
  await socket.connect();
  socket.emit('driver:register', { name: myName, plate: myPlate });
}

function disconnectAll() {
  stopGPS();
  if (socket) socket.disconnect();
  document.getElementById('active-card').classList.add('hidden');
  document.getElementById('register-card').classList.remove('hidden');
}

document.getElementById('btn-register').onclick = async () => {
  const name = document.getElementById('name').value.trim();
  const plate = document.getElementById('plate').value.trim().toUpperCase();
  if (!name || !plate) {
    toast('Ad ve plaka zorunlu', true);
    return;
  }
  myName = name; myPlate = plate;
  saveDriver(name, plate, myStatus);
  try {
    await connectAndRegister();
  } catch (e) {
    toast('Sunucuya bağlanılamadı', true);
    console.error(e);
  }
};

document.getElementById('btn-toggle-status').onclick = () => {
  myStatus = myStatus === 'available' ? 'busy' : 'available';
  document.getElementById('my-status').textContent = myStatus === 'busy' ? '🔴 Meşgul' : '🟢 Müsait';
  if (socket && socket.connected) socket.emit('driver:status', myStatus);
  saveDriver(myName, myPlate, myStatus);
};

document.getElementById('btn-disconnect').onclick = disconnectAll;

// Sayfa açılınca
(async () => {
  const isNative = await detectNative();
  console.log('Native modu:', isNative, 'Plugin:', NativeGeolocation ? 'var' : 'yok');

  const saved = loadSaved();
  if (saved) {
    document.getElementById('name').value = saved.name;
    document.getElementById('plate').value = saved.plate;
    document.getElementById('btn-register').textContent = '🔄 Tekrar Bağlan';
    if (saved.status === 'busy') myStatus = 'busy';
    myName = saved.name;
    myPlate = saved.plate;
  }
})();
