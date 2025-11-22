// Simple script to update the model name in existing settings
// This will update from gemini-1.5-flash to gemini-2.5-flash-lite

const fixSettings = async () => {
  try {
    console.log('Opening IndexedDB...');
    const request = indexedDB.open('RAGWebDB', 1);
    
    request.onsuccess = (event) => {
      const db = event.target.result;
      console.log('Database opened successfully');
      
      const transaction = db.transaction(['settings'], 'readwrite');
      const store = transaction.objectStore('settings');
      const getRequest = store.get('app-settings');
      
      getRequest.onsuccess = () => {
        const settings = getRequest.result;
        if (settings) {
          console.log('Current settings:', settings);
          console.log('Current model:', settings.model);
          
          if (settings.model === 'gemini-1.5-flash') {
            settings.model = 'gemini-2.5-flash-lite';
            console.log('Updating model to:', settings.model);
            
            const updateRequest = store.put(settings);
            updateRequest.onsuccess = () => {
              console.log('Settings updated successfully!');
              console.log('New model:', settings.model);
            };
            updateRequest.onerror = (error) => {
              console.error('Failed to update settings:', error);
            };
          } else {
            console.log('Model is already correct or different:', settings.model);
          }
        } else {
          console.log('No settings found');
        }
      };
      
      getRequest.onerror = (error) => {
        console.error('Failed to get settings:', error);
      };
    };
    
    request.onerror = (error) => {
      console.error('Failed to open database:', error);
    };
  } catch (error) {
    console.error('Error:', error);
  }
};

// Run the fix
fixSettings();