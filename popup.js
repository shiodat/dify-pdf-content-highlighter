document.addEventListener('DOMContentLoaded', function() {
  const extractBtn = document.getElementById('extractBtn');
  const highlightBtn = document.getElementById('highlightBtn');
  const openPdfBtn = document.getElementById('openPdfBtn');
  const referencesSelect = document.getElementById('references');
  const statusDiv = document.getElementById('status');
  const pdfViewer = document.getElementById('pdf-viewer');

  let pdfReferences = [];
  let currentPdfUrl = '';
  let currentPdfContent = '';
  let viewerReady = false;

  // デバッグログ
  function logStatus(message) {
    console.log(message);
    statusDiv.textContent = message;
  }

  // 既存の参照を読み込む
  chrome.storage.local.get(['pdfReferences'], function(result) {
    if (result.pdfReferences && result.pdfReferences.length > 0) {
      pdfReferences = result.pdfReferences;
      updateReferenceSelector();
      logStatus(`Loaded ${pdfReferences.length} PDF references from storage`);
    }
  });

  // PDFの参照を抽出
  extractBtn.addEventListener('click', function() {
    logStatus("Extracting PDF references...");

    // content.jsを実行して結果を取得
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      // スクリプトを直接実行する方法（content.jsを経由しない）
      chrome.scripting.executeScript({
        target: {tabId: tabs[0].id},
        function: extractPdfReferencesFromPage
      }, function(results) {
        if (chrome.runtime.lastError) {
          logStatus(`Error: ${chrome.runtime.lastError.message}`);
          return;
        }

        if (results && results[0] && results[0].result) {
          const references = results[0].result;
          pdfReferences = references;
          logStatus(`Found ${pdfReferences.length} PDF references`);
          chrome.storage.local.set({pdfReferences: pdfReferences});
          updateReferenceSelector();
        } else {
          logStatus("No PDF references found");
        }
      });
    });
  });

  // ページからPDF参照を抽出する関数（ページのコンテキストで実行される）
  function extractPdfReferencesFromPage() {
    // チャンク要素を探す（URLとコンテンツのタグを含む）
    const chunks = document.querySelectorAll('chunk');

    if (!chunks || chunks.length === 0) {
      console.log('No chunks found in the page');
      return [];
    }

    const references = [];

    chunks.forEach(chunk => {
      // URLタグを探す
      const urlTag = chunk.querySelector('url');
      // コンテンツタグを探す
      const contentTag = chunk.querySelector('content');

      if (urlTag && contentTag) {
        const url = urlTag.textContent.trim();
        const content = contentTag.textContent.trim();

        // PDFのURLのみを考慮
        if (url.toLowerCase().endsWith('.pdf')) {
          references.push({
            url: url,
            content: content
          });
          console.log(`Found PDF reference: ${url}`);
        }
      }
    });

    console.log(`Total PDF references found: ${references.length}`);
    return references;
  }

  // PDF参照のドロップダウンを更新
  function updateReferenceSelector() {
    // 既存のオプションをクリア
    while (referencesSelect.options.length > 1) {
      referencesSelect.remove(1);
    }

    // 各参照のオプションを追加
    pdfReferences.forEach((ref, index) => {
      const option = document.createElement('option');
      option.value = index;
      option.textContent = ref.url.split('/').pop(); // ファイル名のみ表示
      referencesSelect.appendChild(option);
    });

    // コントロールの有効/無効を切り替え
    if (pdfReferences.length > 0) {
      referencesSelect.disabled = false;
    } else {
      referencesSelect.disabled = true;
      highlightBtn.disabled = true;
      openPdfBtn.disabled = true;
    }
  }

  // PDF選択の変更を処理
  referencesSelect.addEventListener('change', function() {
    if (this.value === "") {
      highlightBtn.disabled = true;
      openPdfBtn.disabled = true;
      pdfViewer.contentWindow.postMessage({action: 'clear'}, '*');
      currentPdfUrl = '';
      currentPdfContent = '';
      return;
    }

    const selectedRef = pdfReferences[this.value];
    currentPdfUrl = selectedRef.url;
    currentPdfContent = selectedRef.content;

    // ハイライトとオープンボタンを有効化
    highlightBtn.disabled = false;
    openPdfBtn.disabled = false;

    // PDFを読み込む前にステータスを更新
    logStatus(`Loading PDF: ${currentPdfUrl.split('/').pop()}`);

    // PDFをプロキシ経由で取得
    chrome.runtime.sendMessage({
      action: 'proxyPdf',
      url: currentPdfUrl
    }, function(response) {
      if (chrome.runtime.lastError) {
        logStatus(`Error: ${chrome.runtime.lastError.message}`);
        return;
      }

      if (response && response.success) {
        // Base64データが返された場合
        const pdfDataUri = `data:application/pdf;base64,${response.data}`;
        console.log("PDF loaded via proxy, sending to viewer");

        // ビューワーにPDFデータを送信
        pdfViewer.contentWindow.postMessage({
          action: 'loadPdf',
          url: pdfDataUri
        }, '*');
      } else {
        // エラーの場合
        const errorMsg = response?.error || 'Unknown error';
        logStatus(`Error loading PDF via proxy: ${errorMsg}`);

        // 直接URLを試す
        console.log("Trying direct URL as fallback");
        pdfViewer.contentWindow.postMessage({
          action: 'loadPdf',
          url: currentPdfUrl
        }, '*');
      }
    });
  });

  // PDFのコンテンツをハイライト
  highlightBtn.addEventListener('click', function() {
    console.log('Highlight button clicked');

    if (!currentPdfUrl || !currentPdfContent) {
      console.error('No PDF URL or content available');
      logStatus('No PDF content to highlight');
      return;
    }

    console.log('Current PDF URL:', currentPdfUrl);
    console.log('Content to highlight:', currentPdfContent);
    logStatus(`Highlighting content in: ${currentPdfUrl.split('/').pop()}`);

    // ビューワーにハイライト命令を送信
    try {
      pdfViewer.contentWindow.postMessage({
        action: 'highlight',
        content: currentPdfContent
      }, '*');
      console.log('Highlight message sent to viewer');
    } catch (error) {
      console.error('Error sending highlight message:', error);
      logStatus('Failed to send highlight command: ' + error.message);
    }
  });

  // 新しいタブでPDFを開く
  openPdfBtn.addEventListener('click', function() {
    if (currentPdfUrl) {
      chrome.tabs.create({url: currentPdfUrl});
    }
  });

  // PDFビューワーからのメッセージを受信
  window.addEventListener('message', function(event) {
    if (event.data && event.data.action === 'status') {
      logStatus(event.data.message);

      // ビューワーの準備が整ったことを示すメッセージ
      if (event.data.message === 'PDF viewer ready') {
        viewerReady = true;
      }
    }
  });

  // 初期ステータス
  logStatus("PDF Content Highlighter ready. Click 'Extract PDF References' to start.");
});