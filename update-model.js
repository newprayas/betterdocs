// Simple script to update just the model in IndexedDB
// Run this in your browser console on your app page

(async function updateModel() {
  try {
    console.log('[MODEL UPDATE] Starting model update...');
    
    // Open the database
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('RAGChatDB', 1);
      request.onerror = reject;
      request.onsuccess = () => resolve(request.result);
    });
    
    // Get current settings
    const currentSettings = await new Promise((resolve, reject) => {
      const transaction = db.transaction(['settings'], 'readonly');
      const store = transaction.objectStore('settings');
      const request = store.get('app-settings');
      request.onerror = reject;
      request.onsuccess = () => resolve(request.result);
    });
    
    console.log('[MODEL UPDATE] Current settings:', currentSettings);
    
    // Update only the model, preserve everything else
    const updatedSettings = {
      ...currentSettings,
      model: 'gemini-2.5-flash-lite'
    };
    
    // Save updated settings
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(['settings'], 'readwrite');
      const store = transaction.objectStore('settings');
      const request = store.put(updatedSettings);
      request.onerror = reject;
      request.onsuccess = resolve;
    });
    
    // Clear Zustand cache to force refresh
    localStorage.removeItem('settings-store');
    
    console.log('[MODEL UPDATE] Model updated to:', updatedSettings.model);
    console.log('[MODEL UPDATE] Refreshing page...');
    
    // Reload page to apply changes
    setTimeout(() => {
      window.location.reload();
    }, 1000);
    
  } catch (error) {
    console.error('[MODEL UPDATE ERROR]', error);
  }
})();