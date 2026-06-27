// Taksi Sürücü - Native Android uygulaması
// Arka planda bile GPS yayını yapar
import { Capacitor } from 'https://cdn.jsdelivr.net/npm/@capacitor/core@6/+esm';
import { Preferences } from 'https://cdn.jsdelivr.net/npm/@capacitor/preferences@6/+esm';
import { App } from 'https://cdn.jsdelivr.net/npm/@capacitor/app@6/+esm';

const SERVER_URL = 'https://taksi-durak.onrender.com';
const SAVED_KEY = 'taksidurak_driver';
let socket = null;
let myName = '', myPlate = '';
let myStatus = 'available';
let sentCount = 0;
let lastSent = 0;

// Toast
function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), 3000);
}

// Durak bilgisi
fetch(`${SERVER_URL}/api/station`).then(r => r.json()).then(st => {
  document.getElementById('station-name').textContent = st.name + ' • Sürücü';
}).catch(() => {});

// localStorage / Preferences yardımcıları
async function loadSaved() {
  try {
    const { value } = await Preferences.get({ key: SAVED_KEY });
    if (!value) return null;
    const obj = JSON.parse(value);
    if (obj.name && obj.plate) return obj;
  } catch (e) {}
  return null;
}
async function saveDriver(name, plate, status) {
  try {
    await Preferences.set({ key: SAVED_KEY, value: JSON.stringify({ name, plate, status }) });
  } catch (e) {}
}
async function clearSaved() {
  try { await Preferences.remove({ key: SAVED_KEY }); } catch (e) {}
}

// Socket.IO - tarayıcı yerine WebSocket kullan (daha hafif)
class MiniSocket {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.connected = false;
    this.queue = [];
    this.reconnectTimer = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      // Socket.IO URL'den websocket endpoint'i çıkar
      const wsUrl = this.url.replace('https://', 'wss://').replace('http://', 'ws://') + '/socket.io/?EIO=4&transport=websocket';
      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        // Socket.IO handshake packet
        this.sendRaw('0{"sid":"' + Math.random().toString(36).slice(2,12) + '","upgrades":[],"pingInterval":25000,"pingTimeout":5000}');
        this.connected = true;
        resolve();
      };
      this.ws.onclose = () => {
        this.connected = false;
        document.getElementById('server-status').textContent = '❌ Kopuk';
        this.scheduleReconnect();
      };
      this.ws.onerror = (e) => {
        document.getElementById('server-status').textContent = '❌ Hata';
        reject(e);
      };
      this.ws.onmessage = (e) => this.handleMessage(e.data);
    });
  }
  sendRaw(data) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(data);
    }
  }
  emit(event, data) {
    // Socket.IO event packet: 42["event", data]
    const payload = JSON.stringify([event, data]);
    this.sendRaw('42' + payload);
  }
  handleMessage(msg) {
    const data = typeof msg === 'string' ? msg : '';
    if (!data) return;
    const type = data[0];
    if (type === '0') {
      // connect packet
    } else if (type === '2') {
      // ping -> pong
      this.sendRaw('3');
    } else if (type === '3') {
      // pong
    } else if (type === '4') {
      // message
      try {
        const parsed = JSON.parse(data.slice(1));
        const [event, payload] = parsed;
        this.onEvent && this.onEvent(event, payload);
      } catch (e) {}
    }
  }
  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        if (myName && myPlate) {
          this.emit('driver:register', { name: myName, plate: myPlate });
        }
        toast('Yeniden bağlandı');
      } catch (e) {
        this.scheduleReconnect();
      }
    }, 5000);
  }
  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
  }
}

// Arka plan GPS - Capacitor native plugin
async function startBackgroundGPS() {
  if (!Capacitor.isNativePlatform()) {
    // Web'de çalışıyorsa normal watchPosition
    return startWebGPS();
  }

  try {
    // Dynamic import for the native module
    const bgGeo = await import('https://cdn.jsdelivr.net/npm/@capacitor-community/background-geolocation@7/+esm');

    // İzin iste
    const perm = await bgGeo.BackgroundGeolocation.requestPermissions();
    if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
      toast('Konum izni verilmedi', true);
      return;
    }

    // Konum gönderimi için callback
    bgGeo.BackgroundGeolocation.addListener('location', async (loc) => {
      const { latitude, longitude, accuracy, speed, heading, time } = loc;
      document.getElementById('gps-dot').classList.remove('off');
      document.getElementById('gps-status').textContent = 'GPS Aktif (arka plan)';
      document.getElementById('my-coords').textContent = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
      document.getElementById('my-accuracy').textContent = `±${accuracy?.toFixed(0) || '?'} m`;
      if (speed != null) document.getElementById('my-speed').textContent = `${(speed * 3.6).toFixed(1)} km/s`;
      document.getElementById('last-update').textContent = 'şimdi';

      // Sunucuya gönder
      if (socket && socket.connected) {
        socket.emit('driver:location', {
          lat: latitude,
          lng: longitude,
          speed: (speed || 0) * 3.6,
          heading: heading || 0,
          status: myStatus
        });
        sentCount++;
        document.getElementById('sent-count').textContent = sentCount;
      }
    });

    // Arka plan izni
    await bgGeo.BackgroundGeolocation.requestBackgroundPermission();

    // Servisi başlat
    await bgGeo.BackgroundGeolocation.start({
      config: {
        desiredAccuracy: 1, // yüksek doğruluk
        distanceFilter: 5,  // 5 metrede bir
        stopOnTerminate: false, // uygulama kapansa bile çalışsın
        startOnBoot: true,     // telefon yeniden başlayınca otomatik başla
        foregroundService: true,
        notificationTitle: 'Taksi Durağı - Aktif',
        notificationText: 'Konumunuz durağa gönderiliyor',
        notificationIconColor: '#ffd000',
        interval: 3000,       // 3 saniyede bir
        fastestInterval: 2000,
        activitiesInterval: 5000
      }
    });

    document.getElementById('server-status').textContent = '🟢 Aktif';
  } catch (err) {
    console.error('Background GPS error:', err);
    toast('Arka plan GPS başlatılamadı, normal moda geçiliyor', true);
    return startWebGPS();
  }
}

async function stopBackgroundGPS() {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const bgGeo = await import('https://cdn.jsdelivr.net/npm/@capacitor-community/background-geolocation@7/+esm');
    await bgGeo.BackgroundGeolocation.stop();
    await bgGeo.BackgroundGeolocation.removeAllListeners();
  } catch (e) {}
}

function startWebGPS() {
  if (!navigator.geolocation) {
    toast('GPS desteklenmiyor', true);
    return;
  }
  navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude, speed, accuracy } = pos.coords;
      document.getElementById('gps-dot').classList.remove('off');
      document.getElementById('gps-status').textContent = 'GPS Aktif (web)';
      document.getElementById('my-coords').textContent = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
      document.getElementById('my-accuracy').textContent = `±${accuracy.toFixed(0)} m`;
      if (speed != null) document.getElementById('my-speed').textContent = `${(speed * 3.6).toFixed(1)} km/s`;
      document.getElementById('last-update').textContent = 'şimdi';

      if (socket && socket.connected) {
        socket.emit('driver:location', {
          lat: latitude, lng: longitude,
          speed: (speed || 0) * 3.6,
          heading: 0, status: myStatus
        });
        sentCount++;
        document.getElementById('sent-count').textContent = sentCount;
      }
    },
    (err) => {
      document.getElementById('gps-dot').classList.add('off');
      let msg = 'GPS hatası';
      if (err.code === 1) msg = 'Konum izni reddedildi';
      else if (err.code === 2) msg = 'Konum alınamadı';
      else if (err.code === 3) msg = 'GPS zaman aşımı';
      toast(msg, true);
    },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
  );
}

async function connectSocket() {
  socket = new MiniSocket(SERVER_URL);
  socket.onEvent = (event, payload) => {
    if (event === 'driver:registered') {
      document.getElementById('register-card').classList.add('hidden');
      document.getElementById('active-card').classList.remove('hidden');
      document.getElementById('driver-display').textContent = `${myName} • ${myPlate}`;
      document.getElementById('my-status').textContent = myStatus === 'busy' ? '🔴 Meşgul' : '🟢 Müsait';
      document.getElementById('server-status').textContent = '🟢 Bağlı';
      startBackgroundGPS();
      toast('Bağlantı kuruldu');
    } else if (event === 'driver:kicked') {
      toast('Yeni bağlantı açıldı, bu oturum kapatıldı', true);
      disconnectAll();
    } else if (event === 'error:msg') {
      toast(payload, true);
    }
  };
  await socket.connect();
  socket.emit('driver:register', { name: myName, plate: myPlate });
}

function disconnectAll() {
  stopBackgroundGPS();
  if (socket) socket.disconnect();
  document.getElementById('active-card').classList.add('hidden');
  document.getElementById('register-card').classList.remove('hidden');
  toast('Bağlantı kesildi');
}

// Buton olayları
document.getElementById('btn-register').onclick = async () => {
  const name = document.getElementById('name').value.trim();
  const plate = document.getElementById('plate').value.trim().toUpperCase();
  if (!name || !plate) {
    toast('Ad ve plaka zorunlu', true);
    return;
  }
  myName = name; myPlate = plate;
  await saveDriver(name, plate, myStatus);
  try {
    await connectSocket();
  } catch (e) {
    toast('Sunucuya bağlanılamadı', true);
  }
};

document.getElementById('btn-toggle-status').onclick = () => {
  myStatus = myStatus === 'available' ? 'busy' : 'available';
  const labels = { available: '🟢 Müsait', busy: '🔴 Meşgul' };
  document.getElementById('my-status').textContent = labels[myStatus];
  if (socket && socket.connected) socket.emit('driver:status', myStatus);
  saveDriver(myName, myPlate, myStatus);
  toast(myStatus === 'available' ? 'Müsait' : 'Meşgul');
};

document.getElementById('btn-disconnect').onclick = () => {
  disconnectAll();
};

// Sayfa açılınca: kayıtlı bilgi varsa doldur, otomatik bağlan
(async () => {
  const saved = await loadSaved();
  if (saved) {
    document.getElementById('name').value = saved.name;
    document.getElementById('plate').value = saved.plate;
    document.getElementById('btn-register').textContent = '🔄 Tekrar Bağlan';
    document.querySelector('.helper').textContent = '📍 Kayıtlı bilgileriniz hazır';
    if (saved.status === 'busy') myStatus = 'busy';
    myName = saved.name;
    myPlate = saved.plate;
    // Otomatik bağlan
    setTimeout(async () => {
      try { await connectSocket(); } catch (e) {}
    }, 500);
  }
})();

// App lifecycle: arka plana atılınca da GPS devam etsin
if (Capacitor.isNativePlatform()) {
  document.addEventListener('app:stateChange', (e) => {
    // Arka planda da çalışmaya devam et - hiçbir şey yapma
    console.log('App state:', e.detail.isActive ? 'foreground' : 'background');
  });
}