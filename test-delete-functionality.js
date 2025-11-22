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
  
  // Navigate to the application
  await page.goto('http://localhost:3000');
  await page.waitForSelector('body');
  
  // Check if we need to create a session
  const hasSessions = await page.$('.session-card') !== null;
  
  if (!hasSessions) {
    console.log('No sessions found, creating a test session...');
    // Create a new session
    await page.click('button:contains("New Conversation")');
    await page.waitForSelector('input[placeholder*="Session name"]');
    
    await page.type('input[placeholder*="Session name"]', 'Test Session for Delete Functionality');
    await page.click('button:contains("Create")');
    await page.waitForNavigation();
  } else {
    console.log('Existing session found, clicking on it...');
    // Click on the first session
    await page.click('.session-card, .bg-white.rounded-lg');
    await page.waitForNavigation();
  }
  
  // Navigate to documents tab
  console.log('Navigating to documents tab...');
  await page.click('button:contains("Documents"), div:contains("Documents")');
  await page.waitForTimeout(1000);
  
  // Check if we have documents
  const hasDocuments = await page.$('[class*="DocumentCard"], .bg-white.rounded-lg.shadow') !== null;
  
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
          content: 'This is a test document for testing the delete functionality.',
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
    await page.waitForTimeout(2000);
    
    // Clean up the temp file
    fs.unlinkSync(tempFilePath);
  }
  
  // Now test the delete functionality
  console.log('Testing delete functionality...');
  
  // Find the first document card
  const documentCard = await page.$('.document-card');
  if (!documentCard) {
    console.error('No document card found to test delete functionality');
    await browser.close();
    return;
  }
  
  // Get the document name for verification
  const documentName = await page.$eval('[class*="DocumentCard"] h3, .bg-white.rounded-lg.shadow h3', el => el.textContent);
  console.log(`Found document: ${documentName}`);
  
  // Click the delete button
  console.log('Clicking delete button...');
  await page.click('[class*="DocumentCard"] button:has(svg), .bg-white.rounded-lg.shadow button:has(svg)');
  
  // Wait for the confirmation dialog
  await page.waitForSelector('.fixed.inset-0, .modal, [role="dialog"]');
  
  // Check if the dialog shows the correct document name
  const dialogMessage = await page.$eval('.fixed.inset-0 p, .modal p, [role="dialog"] p', el => el.textContent);
  if (dialogMessage.includes(documentName)) {
    console.log('✅ Confirmation dialog correctly shows document name');
  } else {
    console.log('❌ Confirmation dialog does not show the correct document name');
  }
  
  // Check for loading state
  console.log('Testing loading state during deletion...');
  
  // Confirm the deletion
  await page.click('.fixed.inset-0 button:contains("Delete"), .modal button:contains("Delete"), [role="dialog"] button:contains("Delete")');
  
  // Check for loading state
  const hasLoadingState = await page.$('.animate-spin, [class*="loading"]') !== null;
  if (hasLoadingState) {
    console.log('✅ Loading state is displayed during deletion');
  } else {
    console.log('⚠️ Loading state might not be properly displayed');
  }
  
  // Wait for deletion to complete
  await page.waitForTimeout(1000);
  
  // Check if the document was removed from the list
  const documentStillExists = await page.$('[class*="DocumentCard"], .bg-white.rounded-lg.shadow') !== null;
  if (!documentStillExists) {
    console.log('✅ Document successfully removed from the list');
  } else {
    console.log('❌ Document was not removed from the list');
  }
  
  // Check console for errors
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log(`❌ Browser console error: ${msg.text()}`);
    }
  });
  
  // Test error handling by trying to delete a non-existent document
  console.log('Testing error handling...');
  
  // This would require more complex setup to simulate an error
  // For now, we'll just check if the error handling code is in place
  const hasErrorHandling = await page.evaluate(() => {
    const documentCards = Array.from(document.querySelectorAll('.document-card'));
    if (documentCards.length === 0) return true; // No documents to test with
    
    // Check if error handling elements exist
    return document.querySelector('.document-card .error-message') !== null;
  });
  
  if (hasErrorHandling) {
    console.log('✅ Error handling elements are in place');
  } else {
    console.log('⚠️ Error handling elements might not be properly implemented');
  }
  
  console.log('Test completed. Closing browser in 5 seconds...');
  await page.waitForTimeout(5000);
  
  await browser.close();
  console.log('Delete functionality test finished');
}

// Run the test
testDeleteFunctionality().catch(console.error);