// Bấm icon tiện ích -> mở side panel.
// Gọi mỗi khi service worker khởi động để chắc chắn hành vi luôn được đặt.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn('setPanelBehavior:', e));
