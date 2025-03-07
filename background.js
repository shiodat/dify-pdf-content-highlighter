chrome.runtime.onInstalled.addListener(function() {
  console.log('PDF Content Highlighter extension installed');
});

// PDFをプロキシする機能
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.action === 'proxyPdf') {
    console.log('Proxying PDF:', request.url);

    fetch(request.url)
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP error! Status: ${response.status}`);
        }
        return response.arrayBuffer();
      })
      .then(buffer => {
        console.log('PDF fetched, size:', buffer.byteLength, 'bytes');
        // ArrayBufferをBase64に変換
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        console.log('PDF converted to base64');
        sendResponse({success: true, data: base64});
      })
      .catch(error => {
        console.error('Error fetching PDF:', error);
        sendResponse({success: false, error: error.message});
      });

    return true; // 非同期レスポンスを示す
  }
});