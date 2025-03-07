// メッセージリスナー
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  console.log('Content script message received:', request);

  if (request.action === "extract") {
    const references = extractPdfReferences();
    sendResponse({success: true, data: references});
  }

  return true; // 非同期レスポンスを可能にする
});

// PDFの参照とコンテンツをDify会話から抽出する関数
function extractPdfReferences() {
  console.log('Extracting PDF references from page...');

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