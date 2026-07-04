// Taksi Sürücü - Basit HTTP tabanlı, native plugin entegreli
// Sunucu: Render'daki taksi-durak backend
// Her konum güncellemesi basit HTTP POST olarak gönderilir — Socket.IO/WebSocket yok
const SERVER_URL = 'https://taksi-durak.onrender.com';
const SAVED_KEY = 'taksidurak_driver_v3';

let myName = '', myPlate = '', myDriverId = '';
let myStatus = 'available';
let sentCount = 0;
let watchId = null;
let nativeMode = false;
let NativeGeolocation = null;
let lastSendTime = 0;

function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), 3000);
}

function setStatus(text) {
  const el = document.getElementById('server-status');
  if (el) el.textContent = text;
}

function setGpsStatus(text) {
  const el = document.getElementById('gps-status');
  if (el) el.textContent = text;
  const dot = document.getElementById('gps-dot');
  if (dot) dot.classList.remove('off');
}

async function detectNative() {
  try {
    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
      nativeMode = true;
      if (window.Capacitor.Plugins) {
        NativeGeolocation = window.Capacitor.Plugins.Geolocation || window.Capacitor.Plugins.BackgroundGeolocation;
        console.log('Native plugin:', NativeGeolocation ? NativeGeolocation.constructor?.name || 'var' : 'yok');
      }
      return true;
    }
  } catch (e) {
    console.log('Native detect error:', e);
  }
  return false;
}

function loadSaved() {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (obj.name && obj.plate) return obj;
  } catch (e) {}
  return null;
}
function saveDriver(name, plate, status, id) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify({ name, plate, status, id })); } catch (e) {}
}

async function sendLocation(lat, lng, speed, heading) {
  if (!myDriverId) return;
  // 3 saniyede bir throttle
  const now = Date.now();
  if (now - lastSendTime < 3000) return;
  lastSendTime = now;

  try {
    const res = await fetch(`${SERVER_URL}/api/driver/${myDriverId}/location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lng, speed: speed || 0, heading: heading || 0, status: myStatus })
    });
    if (res.ok) {
      sentCount++;
      const el = document.getElementById('sent-count');
      if (el) el.textContent = sentCount;
      setGpsStatus('GPS Aktif');
    } else {
      console.warn('Konum gönderilemedi:', res.status);
    }
  } catch (e) {
    console.warn('Konum gönder hatası:', e.message);
  }
}

async function startGPS() {
  // Önce native plugin dene
  if (nativeMode && NativeGeolocation) {
    try {
      // İzin iste
      if (NativeGeolocation.requestPermissions) {
        const perm = await NativeGeolocation.requestPermissions();
        console.log('İzin sonucu:', JSON.stringify(perm));
        if (perm && perm.location && perm.location !== 'granted') {
          toast('Konum izni verilmedi', true);
        }
      }
      // Dinle
      if (NativeGeolocation.addListener) {
        await NativeGeolocation.addListener('location', (loc) => {
          if (!loc) return;
          setGpsStatus('GPS Aktif (native)');
          const el = document.getElementById('my-coords');
          if (el) el.textContent = `${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}`;
          sendLocation(loc.latitude, loc.longitude, loc.speed ? loc.speed * 3.6 : 0, loc.heading || 0);
        });
      }
      // Başlat (varsa)
      if (NativeGeolocation.start) {
        try { await NativeGeolocation.start({}); } catch (e) { console.log('start:', e.message); }
      }
      return;
    } catch (e) {
      console.error('Native GPS hatası:', e);
    }
  }

  // Fallback: Web Geolocation API
  if (!navigator.geolocation) {
    toast('GPS desteklenmiyor', true);
    return;
  }
  if (watchId !== null) return;
  setGpsStatus('GPS Aktif (web)');
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const el = document.getElementById('my-coords');
      if (el) el.textContent = `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`;
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

async function registerAndStart() {
  setStatus('🔄 Kaydediliyor...');
  try {
    const res = await fetch(`${SERVER_URL}/api/driver/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: myName, plate: myPlate })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Kayıt başarısız');

    myDriverId = data.id;
    saveDriver(myName, myPlate, myStatus, myDriverId);
    setStatus('🟢 Bağlı');

    document.getElementById('register-card').classList.add('hidden');
    document.getElementById('active-card').classList.remove('hidden');
    document.getElementById('driver-display').textContent = `${myName} • ${myPlate}`;
    document.getElementById('my-status').textContent = myStatus === 'busy' ? '🔴 Meşgul' : '🟢 Müsait';

    startGPS();
    toast('Bağlantı kuruldu');
  } catch (e) {
    setStatus('❌ Hata: ' + e.message);
    toast('Bağlantı hatası: ' + e.message, true);
    throw e;
  }
}

async function disconnectAll() {
  stopGPS();
  if (myDriverId) {
    try {
      await fetch(`${SERVER_URL}/api/driver/${myDriverId}`, { method: 'DELETE' });
    } catch (e) {}
  }
  myDriverId = '';
  setStatus('—');
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
  try {
    await registerAndStart();
  } catch (e) {
    console.error('Register error:', e);
  }
};

document.getElementById('btn-toggle-status').onclick = async () => {
  myStatus = myStatus === 'available' ? 'busy' : 'available';
  document.getElementById('my-status').textContent = myStatus === 'busy' ? '🔴 Meşgul' : '🟢 Müsait';
  if (myDriverId) {
    try {
      await fetch(`${SERVER_URL}/api/driver/${myDriverId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: myStatus })
      });
    } catch (e) {}
  }
  saveDriver(myName, myPlate, myStatus, myDriverId);
};

document.getElementById('btn-disconnect').onclick = disconnectAll;

// Sayfa açılınca
(async () => {
  const isNative = await detectNative();
  console.log('Native modu:', isNative);

  const saved = loadSaved();
  if (saved) {
    document.getElementById('name').value = saved.name;
    document.getElementById('plate').value = saved.plate;
    document.getElementById('btn-register').textContent = '🔄 Tekrar Bağlan';
    if (saved.status === 'busy') myStatus = 'busy';
    myName = saved.name;
    myPlate = saved.plate;
    if (saved.id) myDriverId = saved.id;
  }
})();
