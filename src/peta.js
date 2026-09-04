/* ══════════════════════ PILIHAN PETA DASAR ══════════════════════

   Sumber ubinnya sama seperti sebelumnya (Google), hanya parameter `lyrs`
   yang berganti — jadi tidak ada layanan baru yang dipanggil:

     s = citra satelit           (bawaan, seperti sebelumnya)
     y = citra satelit + label   (nama jalan tercetak di atas citra)
     m = peta jalan Google Maps

   Pilihan disimpan per perangkat, jadi tidak perlu diatur ulang tiap kali
   halaman dibuka. Ini murni tampilan: tidak menyentuh data maupun server. */

const PETA_DASAR = [
  { kode: 's', nama: 'Satelit',    judul: 'Citra satelit tanpa label' },
  { kode: 'y', nama: 'Sat+label',  judul: 'Citra satelit dengan nama jalan' },
  { kode: 'm', nama: 'Peta jalan', judul: 'Peta jalan Google Maps' },
];
const LSK_PETA = 'pov_peta';

function urlPeta(kode) {
  return 'https://{s}.google.com/vt/lyrs=' + kode + '&x={x}&y={y}&z={z}';
}

function gantiPetaDasar(kode, diam) {
  const p = PETA_DASAR.find(x => x.kode === kode) || PETA_DASAR[0];
  petaDasar.setUrl(urlPeta(p.kode));
  document.querySelectorAll('#petaPilih button').forEach(b =>
    b.classList.toggle('on', b.dataset.kode === p.kode));
  try { localStorage.setItem(LSK_PETA, p.kode); } catch (e) {}
  if (!diam) toast('Peta dasar: ' + p.nama);
}

function pasangPilihanPeta() {
  const gaya = document.createElement('style');
  gaya.textContent = `
#petaPilih{display:flex;background:rgba(14,18,15,.86);border:1px solid #2c3830;
  border-radius:7px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.4);
  backdrop-filter:blur(3px)}
#petaPilih button{border:0;background:transparent;color:#a8b8ac;font:inherit;
  font-size:11px;padding:5px 9px;cursor:pointer;white-space:nowrap;
  border-right:1px solid #2c3830}
#petaPilih button:last-child{border-right:0}
#petaPilih button:hover{background:#1d241e;color:#dfe8df}
#petaPilih button.on{background:#2f6b3f;color:#eaf6ea}
@media(max-width:640px){#petaPilih button{padding:6px 8px;font-size:10px}}`;
  document.head.appendChild(gaya);

  const Kontrol = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function () {
      const d = L.DomUtil.create('div', '');
      d.id = 'petaPilih';
      d.innerHTML = PETA_DASAR.map(p =>
        `<button type="button" data-kode="${p.kode}" title="${p.judul}">${p.nama}</button>`).join('');
      /* Tanpa ini, klik tombol ikut menggeser peta di belakangnya. */
      L.DomEvent.disableClickPropagation(d);
      L.DomEvent.disableScrollPropagation(d);
      d.querySelectorAll('button').forEach(b =>
        b.onclick = () => gantiPetaDasar(b.dataset.kode));
      return d;
    }
  });
  map.addControl(new Kontrol());

  let simpan = 's';
  try { simpan = localStorage.getItem(LSK_PETA) || 's'; } catch (e) {}
  gantiPetaDasar(simpan, true);
}

pasangPilihanPeta();
