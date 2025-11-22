const puppeteer = require('puppeteer');
const { v4: uuidv4 } = require('uuid');

async function testDeleteFunctionality() {
  console.log('Starting delete functionality test...');
  
  const browser = await puppeteer.launch({ 
    headless: false, // Set to true for headless mode
    devtools: true,
    slowMo: 100 // Slow down actions for better observation
  });
  
  const page = await browser.newPage();
  
  // Set up console logging
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log(`❌ Browser console error: ${msg.text()}`);
    } else if (msg.type() === 'log') {
      console.log(`📝 Browser console log: ${msg.text()}`);
    }
  });
  
  // Navigate to the application
  await page.goto('http://localhost:3000');
  await page.waitForSelector('body');
  console.log('✅ Application loaded successfully');
  
  // Check if we need to create a session
  const hasSessions = await page.evaluate(() => {
    return document.querySelector('.session-card, .bg-white.rounded-lg.shadow') !== null;
  });
  
  if (!hasSessions) {
    console.log('No sessions found, creating a test session...');
    // Create a new session
    await page.click('text=New Conversation');
    await page.waitForSelector('input[placeholder*="Session name"], input[placeholder*="name"]');
    
    await page.type('input[placeholder*="Session name"], input[placeholder*="name"]', 'Test Session for Delete Functionality');
    await page.click('text=Create, text=Save, button[type="submit"]');
    await page.waitForTimeout(2000);
  } else {
    console.log('Existing session found, clicking on it...');
    // Click on the first session
    await page.click('.session-card, .bg-white.rounded-lg.shadow');
    await page.waitForTimeout(2000);
  }
  
  // Navigate to documents tab
  console.log('Navigating to documents tab...');
  await page.click('text=Documents');
  await page.waitForTimeout(1000);
  
  // Check if we have documents
  const hasDocuments = await page.evaluate(() => {
    return document.querySelector('[class*="DocumentCard"], .bg-white.rounded-lg.shadow') !== null;
  });
  
  if (!hasDocuments) {
    console.log('No documents found, creating a test document...');
    // Create a test document using the JSON upload
    const testDocument = {
      id: uuidv4(),
      filename: 'test-document.pdf',
      fileSize: 1024000,
      title: 'Test Document for Delete Functionality',
      author: 'Test Author',
      language: 'en',
      pages: [
        {
          page: 1,
          content: 'This is a test document for testing delete functionality.',
          tokens: 15
        }
      ]
    };
    
    // Create a temporary JSON file
    const fs = require('fs');
    const path = require('path');
    const tempFilePath = path.join(__dirname, 'temp-test-document.json');
    fs.writeFileSync(tempFilePath, JSON.stringify(testDocument, null, 2));
    
    // Upload the file
    const fileInput = await page.$('input[type="file"]');
    await fileInput.uploadFile(tempFilePath);
    
    // Wait for the document to be processed
    await page.waitForTimeout(3000);
    
    // Clean up the temp file
    fs.unlinkSync(tempFilePath);
  }
  
  // Now test the delete functionality
  console.log('Testing delete functionality...');
  
  // Check if we have documents now
  const documentsExist = await page.evaluate(() => {
    return document.querySelector('[class*="DocumentCard"], .bg-white.rounded-lg.shadow') !== null;
  });
  
  if (!documentsExist) {
    console.error('❌ No document card found to test delete functionality');
    await browser.close();
    return;
  }
  
  // Get the document name for verification
  const documentName = await page.evaluate(() => {
    const card = document.querySelector('[class*="DocumentCard"], .bg-white.rounded-lg.shadow');
    const titleElement = card.querySelector('h3, [class*="font-medium"]');
    return titleElement ? titleElement.textContent : 'Unknown Document';
  });
  console.log(`Found document: ${documentName}`);
  
  // Click the delete button (red button with trash icon)
  console.log('Clicking delete button...');
  await page.evaluate(() => {
    const cards = document.querySelectorAll('[class*="DocumentCard"], .bg-white.rounded-lg.shadow');
    if (cards.length > 0) {
      const firstCard = cards[0];
      // Find the delete button (red button with trash icon)
      const buttons = firstCard.querySelectorAll('button');
      for (const button of buttons) {
        const style = window.getComputedStyle(button);
        const hasTrashIcon = button.querySelector('svg');
        if (hasTrashIcon && (style.color.includes('rgb(220, 38, 38)') || style.color.includes('red'))) {
          button.click();
          return true;
        }
      }
    }
    return false;
  });
  
  // Wait for the confirmation dialog
  await page.waitForTimeout(1000);
  
  // Check if the confirmation dialog appeared
  const dialogExists = await page.evaluate(() => {
    return document.querySelector('.fixed.inset-0, .modal, [role="dialog"]') !== null;
  });
  
  if (dialogExists) {
    console.log('✅ Confirmation dialog appeared');
    
    // Check if the dialog shows the correct document name
    const dialogMessage = await page.evaluate(() => {
      const dialog = document.querySelector('.fixed.inset-0, .modal, [role="dialog"]');
      const messageElement = dialog.querySelector('p');
      return messageElement ? messageElement.textContent : '';
    });
    
    if (dialogMessage.includes(documentName)) {
      console.log('✅ Confirmation dialog correctly shows document name');
    } else {
      console.log('⚠️ Confirmation dialog message might not include document name');
      console.log(`Dialog message: ${dialogMessage}`);
    }
    
    // Confirm the deletion
    console.log('Confirming deletion...');
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('.fixed.inset-0 button, .modal button, [role="dialog"] button');
      for (const button of buttons) {
        if (button.textContent.includes('Delete')) {
          button.click();
          return true;
        }
      }
      return false;
    });
    
    // Wait for deletion to complete
    await page.waitForTimeout(2000);
    
    // Check if the document was removed from the list
    const documentStillExists = await page.evaluate(() => {
      return document.querySelector('[class*="DocumentCard"], .bg-white.rounded-lg.shadow') !== null;
    });
    
    if (!documentStillExists) {
      console.log('✅ Document successfully removed from the list');
    } else {
      console.log('❌ Document was not removed from the list');
    }
  } else {
    console.log('❌ Confirmation dialog did not appear');
  }
  
  // Test error handling by checking if error elements exist
  console.log('Testing error handling...');
  
  const hasErrorHandling = await page.evaluate(() => {
    // Check if error handling elements exist in the document cards
    const cards = document.querySelectorAll('[class*="DocumentCard"], .bg-white.rounded-lg.shadow');
    for (const card of cards) {
      if (card.querySelector('.error-message, [class*="error"]')) {
        return true;
      }
    }
    return false;
  });
  
  if (hasErrorHandling) {
    console.log('✅ Error handling elements are in place');
  } else {
    console.log('⚠️ Error handling elements might not be visible (this is normal if no errors occurred)');
  }
  
  console.log('Test completed. Closing browser in 5 seconds...');
  await page.waitForTimeout(5000);
  
  await browser.close();
  console.log('Delete functionality test finished');
}

// Run the test
testDeleteFunctionality().catch(console.error);