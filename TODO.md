# TODO

## Sayfa önizlemesi (page preview / thumbnail) — sonraki aşama

Hedef: Sekmelerin/karoların gerçek sayfa görüntüsünü (küçük ekran görüntüsü)
göstermek — SuperFocus / "Super Focus Tabs" eklentisindeki "thumbnail/preview"
gibi. Özellikle **Double** görünümünde her kopyanın yanında o sayfanın
önizlemesi görünebilir.

### Eski deney (iptal edildi)
- `popup.html` + `popup.js` toolbar popup'ı "icon preview" (favicon'lu karo
  aynası) deneyiydi. **Artık kullanılmıyor, discard edildi** (manifest'teki
  `action`/`default_popup` bloğu da geri alındı). Yeni preview bunun yerine
  gerçek sayfa thumbnail'i olacak.

### Teknik yöntem (araştırma sonucu)
Referans: açık kaynak `jeanlucthumm/tab-view` + "Super Focus Tabs" aynı tekniği
kullanıyor.

- **Ana API:** `chrome.tabs.captureVisibleTab(windowId, { format, quality })`
  → o an **görünür** sekmenin ekran görüntüsünü **data URI** (base64) olarak verir.
- **Akış:**
  1. Service worker (`background.js`) `chrome.tabs.onActivated` / `onUpdated`
     dinler; aktif sekme her değiştiğinde görüntüsünü yakalar.
  2. Görüntü `chrome.storage.local`'a sekme/URL anahtarıyla data URI olarak yazılır.
  3. Önizleme gösterilirken sekmeler sorgulanır, her birinin önbellekteki
     thumbnail'i `<img>` ile çizilir (favicon'a fallback).
- **Kritik kısıt:** `captureVisibleTab` SADECE o an görünür (aktif+odakta) sekmeyi
  çekebilir; arka plan sekmeleri doğrudan yakalanamaz. Bu yüzden görüntüler
  "tembel" toplanır ve hiç ziyaret edilmemiş sekmelerde placeholder gösterilir.
  Çözüm: opsiyonel **"Scan"** butonu — sekmeleri sırayla kısa süre aktif edip
  görüntüleri doldurur.

### Bu eklentiye eklemek için yapılacaklar
- [ ] manifest: `captureVisibleTab` için host izni gerekli — `"<all_urls>"`
      (veya `"activeTab"` + kullanıcı jesti). İzin etkisini değerlendir.
- [ ] `background.js`: `onActivated` / `onUpdated(status==='complete')` dinleyici
      → `chrome.tabs.captureVisibleTab(winId, { format: 'jpeg', quality: 50 })`.
      Boyut için JPEG + düşük kalite (depolama/performans).
- [ ] `chrome.storage.local`'a URL bazlı kaydet (anahtar = URL). Eski/şişen
      kayıtları sınırla (TV_CAP benzeri bir tavan / LRU).
- [ ] **Double** satırlarında (ve istenirse karolarda) favicon yerine thumbnail
      göster; yoksa favicon'a düş.
- [ ] Opsiyonel "Scan" butonu (görünmemiş sekmelerin görüntüsünü doldurmak için).
- [ ] Hover'da büyük önizleme (popover) opsiyonu düşünülebilir.

### Kaynaklar
- jeanlucthumm/tab-view (GitHub) — captureVisibleTab + storage + iframe overlay
- Super Focus Tabs (Chrome Web Store) — liste/thumbnail/tree görünümü + preview
