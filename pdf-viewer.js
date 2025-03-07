// PDF.jsライブラリをESモジュールとしてインポート
import * as pdfjsLib from './pdfjs/build/pdf.mjs';

// ワーカーの設定
pdfjsLib.GlobalWorkerOptions.workerSrc = './pdfjs/build/pdf.worker.mjs';

// DOM要素の参照
const placeholder = document.getElementById('placeholder');
const loading = document.getElementById('loading');
const error = document.getElementById('error');
const viewerContainer = document.getElementById('viewerContainer');
const viewer = document.getElementById('viewer');

// PDF関連の変数
let pdfDoc = null;
let pdfPages = [];
let textLayers = [];
let scale = 0.5; // デフォルトのスケールを1.0から1.2に増加
const MIN_SCALE = 0.5;
const MAX_SCALE = 3.0;
const SCALE_STEP = 0.2;

// 最後にハイライトされたコンテンツを保存
let lastHighlightContent = '';

// メッセージを親ウィンドウに送信
function sendStatusMessage(message) {
  console.log(message);
  window.parent.postMessage({
    action: 'status',
    message: message
  }, '*');
}

// エラーの表示
function showError(message) {
  console.error(message);
  loading.style.display = 'none';
  viewerContainer.style.display = 'none';
  placeholder.style.display = 'none';
  error.style.display = 'block';
  error.textContent = message;
  sendStatusMessage('Error: ' + message);
}

// ズームコントロールを作成
function createZoomControls() {
  const zoomControls = document.createElement('div');
  zoomControls.className = 'zoom-controls';

  const zoomOutBtn = document.createElement('button');
  zoomOutBtn.textContent = '−';
  zoomOutBtn.title = 'ズームアウト';
  zoomOutBtn.addEventListener('click', () => changeScale(-SCALE_STEP));

  const zoomValue = document.createElement('span');
  zoomValue.className = 'zoom-value';
  zoomValue.textContent = `${Math.round(scale * 100)}%`;

  const zoomInBtn = document.createElement('button');
  zoomInBtn.textContent = '+';
  zoomInBtn.title = 'ズームイン';
  zoomInBtn.addEventListener('click', () => changeScale(SCALE_STEP));

  zoomControls.appendChild(zoomOutBtn);
  zoomControls.appendChild(zoomValue);
  zoomControls.appendChild(zoomInBtn);

  document.body.appendChild(zoomControls);

  return zoomValue; // ズーム値表示要素を返す
}

let zoomValueDisplay = null;

// スケール変更と再レンダリング
async function changeScale(delta) {
  const oldScale = scale;
  scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale + delta));

  if (scale === oldScale) return; // スケールに変更がなければ何もしない

  // ズーム値表示を更新
  if (zoomValueDisplay) {
    zoomValueDisplay.textContent = `${Math.round(scale * 100)}%`;
  }

  // 現在のスクロール位置を保存
  const viewerContainer = document.getElementById('viewerContainer');
  const scrollFraction = {
    x: viewerContainer.scrollLeft / viewerContainer.scrollWidth,
    y: viewerContainer.scrollTop / viewerContainer.scrollHeight
  };

  // ページをクリアして再レンダリング
  const viewer = document.getElementById('viewer');
  viewer.innerHTML = '';

  // PDFページのクリア
  pdfPages = [];
  textLayers = [];

  // ページを再レンダリング
  const pagesToRender = Math.min(pdfDoc.numPages, 5); // パフォーマンスのために5ページに制限
  for (let i = 1; i <= pagesToRender; i++) {
    await renderPage(i);
  }

  // スクロール位置を復元
  setTimeout(() => {
    viewerContainer.scrollLeft = viewerContainer.scrollWidth * scrollFraction.x;
    viewerContainer.scrollTop = viewerContainer.scrollHeight * scrollFraction.y;
  }, 100);

  // ハイライトを再適用（保存されていれば）
  if (lastHighlightContent) {
    highlightContent(lastHighlightContent);
  }
}

// 遅延読み込み（Lazy Loading）の設定
function setupLazyLoading() {
  let renderedPages = new Set(); // すでにレンダリングされたページ
  let isLoading = false; // レンダリング中フラグ

  // 最初の数ページを記録
  for (let i = 1; i <= Math.min(pdfDoc.numPages, 3); i++) {
    renderedPages.add(i);
  }

  viewerContainer.addEventListener('scroll', function() {
    if (!pdfDoc || isLoading) return;

    const visibleTop = viewerContainer.scrollTop;
    const visibleBottom = visibleTop + viewerContainer.clientHeight;
    const buffer = viewerContainer.clientHeight * 1.5; // スクロール方向の先読み範囲

    const pageElements = viewer.querySelectorAll('.page');

    // 現在見えているページを特定
    let visiblePageNumbers = [];
    pageElements.forEach(pageElem => {
      const pageRect = pageElem.getBoundingClientRect();
      const pageTop = pageRect.top;
      const pageBottom = pageRect.bottom;

      // ページの一部が見えている場合
      if ((pageTop >= 0 && pageTop <= viewerContainer.clientHeight) ||
          (pageBottom >= 0 && pageBottom <= viewerContainer.clientHeight) ||
          (pageTop < 0 && pageBottom > viewerContainer.clientHeight)) {
        visiblePageNumbers.push(parseInt(pageElem.dataset.pageNumber));
      }
    });

    // 可視範囲に近い未レンダリングのページを特定して読み込み
    if (visiblePageNumbers.length > 0) {
      const lowestVisiblePage = Math.min(...visiblePageNumbers);
      const highestVisiblePage = Math.max(...visiblePageNumbers);

      // 前後のページをプリロード
      const pagesToLoad = [];

      // 下方向へのプリロード
      for (let i = highestVisiblePage + 1; i <= Math.min(pdfDoc.numPages, highestVisiblePage + 3); i++) {
        if (!renderedPages.has(i)) {
          pagesToLoad.push(i);
        }
      }

      // 上方向へのプリロード
      for (let i = lowestVisiblePage - 1; i >= Math.max(1, lowestVisiblePage - 1); i--) {
        if (!renderedPages.has(i)) {
          pagesToLoad.push(i);
        }
      }

      // ページを順次読み込み
      if (pagesToLoad.length > 0) {
        isLoading = true;
        console.log(`Loading additional pages: ${pagesToLoad.join(', ')}`);

        // ローディングインジケータを表示
        const loadingIndicator = document.createElement('div');
        loadingIndicator.className = 'page-loading-indicator';
        loadingIndicator.textContent = 'Loading more pages...';
        viewer.appendChild(loadingIndicator);

        // 順次ページをレンダリング
        const loadPage = async (index) => {
          if (index >= pagesToLoad.length) {
            // 全ページ読み込み完了
            isLoading = false;
            loadingIndicator.remove();
            return;
          }

          const pageNum = pagesToLoad[index];
          try {
            await renderPage(pageNum);
            renderedPages.add(pageNum);
            // 少し遅延を入れて次のページをレンダリング
            setTimeout(() => loadPage(index + 1), 100);
          } catch (err) {
            console.error(`Failed to render page ${pageNum}:`, err);
            // エラーが発生しても次のページを続行
            setTimeout(() => loadPage(index + 1), 100);
          }
        };

        // 最初のページからレンダリング開始
        loadPage(0);
      }
    }
  }, { passive: true });
}
// PDFの読み込み
async function loadPdf(url) {
  console.log('Loading PDF from:', url.substring(0, 50) + '...');

  // 表示状態を更新
  loading.style.display = 'flex'; // blockからflexに変更
  placeholder.style.display = 'none';
  error.style.display = 'none';
  viewerContainer.style.display = 'none';
  viewer.innerHTML = '';

  // ローディングテキストを更新
  const loadingText = document.getElementById('loading-text');
  if (loadingText) {
    loadingText.textContent = 'Loading PDF...';
  }

  // PDF関連変数をリセット
  pdfDoc = null;
  pdfPages = [];
  textLayers = [];
  lastHighlightContent = '';

  try {
    // データURLからPDFを読み込む場合
    let pdfData;
    if (url.startsWith('data:application/pdf;base64,')) {
      console.log('Loading from Data URL');
      // Base64部分を抽出
      const base64 = url.substring('data:application/pdf;base64,'.length);
      // Base64をバイナリに変換
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      pdfData = {
        data: bytes.buffer
      };
    } else {
      // 通常のURLから読み込む
      console.log('Loading from URL');
      pdfData = {
        url: url
      };
    }

    // PDF.jsでPDFを読み込む
    const loadingTask = pdfjsLib.getDocument(pdfData);

    // 進捗状況の監視
    loadingTask.onProgress = function (progressData) {
      if (progressData.total) {
        const percentLoaded = Math.round((progressData.loaded / progressData.total) * 100);
        if (loadingText) {
          loadingText.textContent = `Loading PDF: ${percentLoaded}%`;
        }
        sendStatusMessage(`Loading PDF: ${percentLoaded}%`);
      }
    };

    // PDFの読み込み完了を待つ
    pdfDoc = await loadingTask.promise;
    console.log(`PDF loaded successfully. Pages: ${pdfDoc.numPages}`);

    if (loadingText) {
      loadingText.textContent = 'Rendering pages...';
    }

    // ズームコントロールを初期化
    if (!zoomValueDisplay) {
      zoomValueDisplay = createZoomControls();
    }

    // 最初の数ページをレンダリング（プレビュー用）
    const pagesToRender = Math.min(pdfDoc.numPages, 3); // パフォーマンスのために3ページに制限

    for (let i = 1; i <= pagesToRender; i++) {
      if (loadingText) {
        loadingText.textContent = `Rendering page ${i} of ${pagesToRender}...`;
      }
      await renderPage(i);
    }

    // 遅延読み込みをセットアップ
    setupLazyLoading();

    // 表示を更新
    loading.style.display = 'none';
    viewerContainer.style.display = 'block';
    sendStatusMessage(`PDF loaded: ${pagesToRender} of ${pdfDoc.numPages} pages rendered`);

  } catch (err) {
    console.error('Error loading PDF:', err);
    showError(`Failed to load PDF: ${err.message}`);
  }
}

// PDFページのレンダリング
async function renderPage(pageNumber) {
  try {
    // ページを取得
    const page = await pdfDoc.getPage(pageNumber);
    pdfPages.push(page);

    // 高解像度レンダリングのためのスケール調整
    // デバイスピクセル比を考慮して高解像度化
    const pixelRatio = window.devicePixelRatio || 1;
    const viewport = page.getViewport({
      scale: scale * 1.5 * pixelRatio  // 基本スケールの1.5倍、デバイスピクセル比も考慮
    });

    // ページコンテナを作成
    const pageContainer = document.createElement('div');
    pageContainer.className = 'page';
    pageContainer.dataset.pageNumber = pageNumber;

    // CSS上のサイズはピクセル比を補正
    pageContainer.style.width = `${viewport.width / pixelRatio}px`;
    pageContainer.style.height = `${viewport.height / pixelRatio}px`;
    viewer.appendChild(pageContainer);

    // キャンバスを作成
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false }); // アルファチャンネル無効化でパフォーマンス向上

    // 高解像度キャンバス
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    // CSSでスケールダウン
    canvas.style.width = `${viewport.width / pixelRatio}px`;
    canvas.style.height = `${viewport.height / pixelRatio}px`;

    pageContainer.appendChild(canvas);

    // レンダリングオプションを設定
    const renderContext = {
      canvasContext: context,
      viewport: viewport,
      renderInteractiveForms: true,
      enableWebGL: true
    };

    // PDFページを高品質でレンダリング
    await page.render(renderContext).promise;

    // テキストレイヤーを作成
    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';

    // テキストレイヤーのCSSサイズ調整
    textLayerDiv.style.width = `${viewport.width / pixelRatio}px`;
    textLayerDiv.style.height = `${viewport.height / pixelRatio}px`;

    pageContainer.appendChild(textLayerDiv);

    // テキストコンテンツを取得
    const textContent = await page.getTextContent();

    // テキストレイヤーをレンダリング
    const textLayer = renderTextLayer(textContent, textLayerDiv, viewport, pixelRatio);
    textLayers.push(textLayer);

    return textLayerDiv;
  } catch (err) {
    console.error(`Error rendering page ${pageNumber}:`, err);
    sendStatusMessage(`Error rendering page ${pageNumber}: ${err.message}`);
    throw err;
  }
}
// renderTextLayer関数の全体を書き換える
function renderTextLayer(textContent, container, viewport, pixelRatio) {
  const textItems = textContent.items;
  const textDivs = [];

  // コンテナ自体を不可視にするが、背景色は見えるように
  container.style.color = 'rgba(0,0,0,0)';  // 文字色を完全透明に

  // テキスト項目ごとにスパンを作成
  for (let i = 0; i < textItems.length; i++) {
    const item = textItems[i];

    // テキスト項目の位置を計算
    const tx = pdfjsLib.Util.transform(
      viewport.transform,
      item.transform
    );

    // スタイルを設定（ピクセル比で調整）
    const fontHeight = Math.sqrt((tx[2] * tx[2]) + (tx[3] * tx[3]));
    const adjustedFontHeight = fontHeight / pixelRatio;

    const style = {
      height: `${adjustedFontHeight}px`,
      width: `${(item.width * viewport.scale) / pixelRatio}px`,
      left: `${tx[4] / pixelRatio}px`,
      top: `${(tx[5] - fontHeight) / pixelRatio}px`,
      fontSize: `${adjustedFontHeight}px`,
      transform: `scaleX(${viewport.scale / pixelRatio})`,
      // カラーを完全透明に
      color: 'rgba(0,0,0,0)',
      backgroundColor: 'transparent'
    };

    // スパン要素を作成
    const textDiv = document.createElement('span');
    textDiv.textContent = item.str;

    // すべてのスタイルを適用
    Object.assign(textDiv.style, style);
    textDiv.style.position = 'absolute';

    container.appendChild(textDiv);
    textDivs.push(textDiv);
  }

  return {
    textDivs,
    textItems
  };
}

// ハイライト部分を修正
function highlightSpanRange(textDivs, startIndex, endIndex, score) {
  const highlightedSpans = [];
  const startSpan = Math.max(0, startIndex);
  const endSpan = Math.min(textDivs.length - 1, endIndex);

  for (let i = startSpan; i <= endSpan; i++) {
    const span = textDivs[i];

    // ハイライト背景色を直接設定
    if (score >= 0.8) {
      span.style.backgroundColor = 'rgba(255, 187, 0, 0.85)';
    } else if (score >= 0.6) {
      span.style.backgroundColor = 'rgba(255, 207, 51, 0.75)';
    } else {
      span.style.backgroundColor = 'rgba(255, 237, 102, 0.65)';
    }

    // クラスも追加（CSS用）
    span.classList.add('highlight');

    highlightedSpans.push(span);
  }

  return highlightedSpans;
}

// ハイライトのクリア（修正版）
function clearHighlights() {
  document.querySelectorAll('.textLayer .highlight').forEach(span => {
    // クラスの除去のみ行い、元のスタイルを保持
    span.classList.remove('highlight');
    span.classList.remove('highlight-high');
    span.classList.remove('highlight-medium');
    span.classList.remove('highlight-low');

    // 追加したスタイルがあれば削除
    span.style.removeProperty('background-color');
  });
}

// テキストのハイライト（チャンクベースの改善版）
function highlightContent(content) {
  // 既存のハイライトをクリア
  clearHighlights();

  if (!content || content.trim() === '') {
    sendStatusMessage('No content to highlight');
    return;
  }

  if (!pdfDoc || textLayers.length === 0) {
    sendStatusMessage('No PDF loaded to highlight');
    return;
  }

  // ハイライト内容を保存
  lastHighlightContent = content;

  console.log(`Attempting to highlight content with length: ${content.length}`);
  console.log(`Content preview: "${content.substring(0, 100)}..."`);

  // テキストを正規化
  const normalizedContent = normalizeText(content);

  // コンテンツをチャンクに分割
  const contentChunks = chunkText(normalizedContent, 10); // 約50文字ごとにチャンク化
  console.log(`Content divided into ${contentChunks.length} chunks`);
  contentChunks.forEach((chunk, i) => {
    if (i < 5) console.log(`Chunk ${i}: "${chunk}"`); // 最初の5チャンクのみ表示
  });

  // 各ページのPDFテキストをチャンク化して保存
  const pdfTextChunks = [];
  let allPdfText = '';

  textLayers.forEach((layer, pageIndex) => {
    // このページのすべてのテキストを連結して正規化
    const pageTextRaw = layer.textDivs.map(div => div.textContent).join(' ');
    const pageText = normalizeText(pageTextRaw);
    allPdfText += pageText + ' ';

    // このページのテキストをチャンク化
    const pageChunks = chunkText(pageText, 10);
    console.log(`Page ${pageIndex + 1}: Created ${pageChunks.length} text chunks`);

    pdfTextChunks.push({
      pageIndex,
      chunks: pageChunks,
      textDivs: layer.textDivs
    });
  });

  // マッチング情報を保存する配列
  let matchResults = [];

  // チャンクの連続マッチングを探す
  for (const pageDef of pdfTextChunks) {
    const { pageIndex, chunks, textDivs } = pageDef;

    // このページの各チャンクに対して
    for (let i = 0; i < chunks.length; i++) {
      // 各コンテンツチャンクとの類似度を計算
      for (let j = 0; j < contentChunks.length; j++) {
        const pdfChunk = chunks[i];
        const searchChunk = contentChunks[j];

        // 類似度を計算
        const similarity = calculateSimilarity(pdfChunk, searchChunk);

        // 一定以上の類似度があれば記録
        if (similarity > 0.4) {
          matchResults.push({
            pageIndex,
            pdfChunkIndex: i,
            contentChunkIndex: j,
            pdfChunk,
            searchChunk,
            similarity,
            startPos: i,
            consecutiveCount: 1
          });
        }
      }
    }
  }

  // 連続するマッチングを探し、スコアを増加させる
  const consecutiveMatches = findConsecutiveMatches(matchResults, pdfTextChunks);
  console.log(`Found ${consecutiveMatches.length} consecutive match sequences`);

  // マッチしたテキストエリアにハイライトを適用
  let foundHighlights = 0;
  let bestMatchSpan = null;
  let bestMatchScore = 0;

  if (consecutiveMatches.length > 0) {
    // 各連続マッチングシーケンスに対して
    for (const match of consecutiveMatches) {
      const { pageIndex, startSpanIndex, endSpanIndex, score } = match;

      // このページのテキスト要素を取得
      const textDivs = pdfTextChunks[pageIndex].textDivs;

      // 対応するテキスト要素にハイライトを適用
      const highlightedSpans = highlightSpanRange(textDivs, startSpanIndex, endSpanIndex, score);
      foundHighlights += highlightedSpans.length;

      // 最良のマッチを記録
      if (score > bestMatchScore && highlightedSpans.length > 0) {
        bestMatchScore = score;
        bestMatchSpan = highlightedSpans[0];
      }
    }
  }

  // バックアップ：チャンク化しない従来の方法でもマッチングを試みる
  if (foundHighlights === 0) {
    console.log("No chunk matches found, trying traditional matching");
    foundHighlights = performTraditionalMatching(normalizedContent, allPdfText);
  }

  // 結果を表示
  if (bestMatchSpan) {
    bestMatchSpan.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });
    sendStatusMessage(`Text highlighted with ${Math.round(bestMatchScore * 100)}% match (${foundHighlights} highlights)`);
  } else if (foundHighlights > 0) {
    sendStatusMessage(`Found ${foundHighlights} text matches`);
  } else {
    sendStatusMessage('No similar text found in document');
    console.log('No matches found. Text might be significantly different from the content in PDF.');
  }

  return foundHighlights > 0;
}

// テキストを適切なサイズのチャンクに分割する
function chunkText(text, chunkSize) {
  // 文章を文単位で分割（句点、感嘆符、疑問符で区切る）
  const sentences = text.split(/(?<=[。．.!?！？])\s*/);
  const chunks = [];
  let currentChunk = '';

  for (const sentence of sentences) {
    // 文が長すぎる場合は独立したチャンクに
    if (sentence.length > chunkSize * 1.5) {
      // 現在のチャンクがある場合は追加
      if (currentChunk) chunks.push(currentChunk);

      // 長い文を複数のチャンクに分割
      let remainingSentence = sentence;
      while (remainingSentence.length > 0) {
        const sentenceChunk = remainingSentence.substring(0, chunkSize);
        chunks.push(sentenceChunk);
        remainingSentence = remainingSentence.substring(chunkSize);
      }

      currentChunk = '';
    }
    // 現在のチャンクにこの文を追加するとチャンクサイズを超える場合
    else if (currentChunk.length + sentence.length > chunkSize) {
      chunks.push(currentChunk);
      currentChunk = sentence;
    }
    // 現在のチャンクに文を追加
    else {
      currentChunk += sentence;
    }
  }

  // 最後のチャンクを追加
  if (currentChunk) chunks.push(currentChunk);

  return chunks;
}

// 2つのテキストの類似度を計算（0〜1の値）
function calculateSimilarity(text1, text2) {
  if (!text1 || !text2) return 0;

  // 1. 完全一致
  if (text1.toLowerCase() === text2.toLowerCase()) return 1.0;

  // 2. 含有チェック
  const lower1 = text1.toLowerCase();
  const lower2 = text2.toLowerCase();

  if (lower1.includes(lower2) || lower2.includes(lower1)) {
    const lengthRatio = Math.min(lower1.length, lower2.length) / Math.max(lower1.length, lower2.length);
    return 0.8 * lengthRatio;
  }

  // 3. 単語の一致率
  const words1 = lower1.split(/\s+/).filter(w => w.length > 2);
  const words2 = lower2.split(/\s+/).filter(w => w.length > 2);

  if (words1.length === 0 || words2.length === 0) return 0;

  let matchCount = 0;
  for (const word of words1) {
    if (words2.includes(word)) matchCount++;
  }

  const wordSimilarity = matchCount / Math.max(words1.length, words2.length);

  // 4. 文字レベルの類似度 (簡易版ジャロ・ウィンクラー)
  const charMatches = longestCommonSubstring(lower1, lower2);
  const charSimilarity = (2 * charMatches) / (lower1.length + lower2.length);

  // 総合スコア (単語類似度と文字類似度の加重平均)
  return (wordSimilarity * 0.6) + (charSimilarity * 0.4);
}

// 最長共通部分文字列の長さを返す
function longestCommonSubstring(str1, str2) {
  if (!str1 || !str2) return 0;

  let longest = 0;
  const table = Array(str1.length).fill().map(() => Array(str2.length).fill(0));

  for (let i = 0; i < str1.length; i++) {
    for (let j = 0; j < str2.length; j++) {
      if (str1[i] === str2[j]) {
        if (i === 0 || j === 0) {
          table[i][j] = 1;
        } else {
          table[i][j] = table[i-1][j-1] + 1;
        }

        if (table[i][j] > longest) {
          longest = table[i][j];
        }
      }
    }
  }

  return longest;
}

// 連続するマッチングを特定する
function findConsecutiveMatches(matchResults, pdfTextChunks) {
  if (!matchResults.length) return [];

  // ページとコンテンツチャンクインデックスでソート
  matchResults.sort((a, b) => {
    if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
    if (a.pdfChunkIndex !== b.pdfChunkIndex) return a.pdfChunkIndex - b.pdfChunkIndex;
    return a.contentChunkIndex - b.contentChunkIndex;
  });

  const consecutiveGroups = [];
  let currentGroup = null;

  for (const match of matchResults) {
    if (!currentGroup ||
        match.pageIndex !== currentGroup.pageIndex ||
        match.pdfChunkIndex !== currentGroup.lastPdfChunkIndex + 1 ||
        Math.abs(match.contentChunkIndex - currentGroup.lastContentChunkIndex - 1) > 1) {

      // 新しいグループを開始
      currentGroup = {
        pageIndex: match.pageIndex,
        startPdfChunkIndex: match.pdfChunkIndex,
        lastPdfChunkIndex: match.pdfChunkIndex,
        startContentChunkIndex: match.contentChunkIndex,
        lastContentChunkIndex: match.contentChunkIndex,
        matches: [match],
        totalSimilarity: match.similarity
      };
      consecutiveGroups.push(currentGroup);
    } else {
      // 既存のグループに追加
      currentGroup.lastPdfChunkIndex = match.pdfChunkIndex;
      currentGroup.lastContentChunkIndex = match.contentChunkIndex;
      currentGroup.matches.push(match);
      currentGroup.totalSimilarity += match.similarity;
    }
  }

  // 各ページのチャンクとスパンの対応関係を計算
  const pageSpanMappings = [];
  for (const pageDef of pdfTextChunks) {
    const mapping = calculateChunkToSpanMapping(pageDef);
    pageSpanMappings.push(mapping);
  }

  // 各グループをスパンインデックスに変換
  const spanRanges = consecutiveGroups.map(group => {
    const mapping = pageSpanMappings[group.pageIndex];

    // チャンクインデックスからスパンインデックスへ
    const startSpanIndex = mapping[group.startPdfChunkIndex]?.startSpan || 0;
    const endSpanIndex = mapping[group.lastPdfChunkIndex]?.endSpan || 0;

    // 連続マッチスコアを計算
    const chunkCount = group.lastPdfChunkIndex - group.startPdfChunkIndex + 1;
    const avgSimilarity = group.totalSimilarity / group.matches.length;
    const sequenceScore = avgSimilarity * (1 + Math.min(0.5, chunkCount * 0.1));

    return {
      pageIndex: group.pageIndex,
      startSpanIndex,
      endSpanIndex,
      chunkCount,
      score: sequenceScore
    };
  });

  // スコアでソート
  return spanRanges.sort((a, b) => b.score - a.score);
}

// チャンクからスパンインデックスへの対応を計算
function calculateChunkToSpanMapping(pageDef) {
  const { chunks, textDivs } = pageDef;
  const mapping = [];

  let currentTextIndex = 0;
  let currentText = '';

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkMapping = { chunk, startSpan: currentTextIndex, endSpan: currentTextIndex };

    // このチャンクに必要なテキストを収集
    while (currentTextIndex < textDivs.length) {
      const spanText = textDivs[currentTextIndex].textContent;
      currentText += spanText + ' ';

      // このスパンを含める
      chunkMapping.endSpan = currentTextIndex;

      // 十分なテキストを集めた場合
      if (normalizeText(currentText).includes(normalizeText(chunk))) {
        break;
      }

      currentTextIndex++;
    }

    mapping.push(chunkMapping);

    // 次のチャンクのために準備
    currentTextIndex = chunkMapping.endSpan;
    currentText = '';
  }

  return mapping;
}

// 従来型の単語ベースマッチング (バックアップとして)
function performTraditionalMatching(normalizedContent, allPdfText) {
  // 重要な単語を抽出 (4文字以上)
  const importantWords = normalizedContent.split(/\s+/)
    .filter(word => word.length >= 4)
    .map(word => word.toLowerCase());

  // 頻出語を除外 (必要に応じて)
  const uniqueWords = [...new Set(importantWords)];
  console.log(`Trying to match ${uniqueWords.length} unique important words`);

  // 各ページで単語マッチを試みる
  let totalHighlights = 0;

  textLayers.forEach((layer, pageIndex) => {
    const textDivs = layer.textDivs;

    textDivs.forEach(span => {
      const spanText = normalizeText(span.textContent).toLowerCase();

      for (const word of uniqueWords) {
        if (spanText.includes(word)) {
          span.classList.add('highlight');
          span.classList.add('highlight-low');
          totalHighlights++;
          break;
        }
      }
    });
  });

  return totalHighlights;
}

// テキスト正規化
function normalizeText(text) {
  if (!text) return '';

  return text
    .replace(/\s+/g, ' ')  // 連続する空白を単一の空白に
    .replace(/[\n\r\t]/g, ' ')  // 改行やタブを空白に
    .replace(/[　]/g, ' ')  // 全角スペースを半角に
    .trim();  // 前後の空白を削除
}

// ビューワーのクリア
function clearViewer() {
  viewer.innerHTML = '';
  viewerContainer.style.display = 'none';
  placeholder.style.display = 'block';
  loading.style.display = 'none';
  error.style.display = 'none';

  // ズームコントロールを削除
  const zoomControls = document.querySelector('.zoom-controls');
  if (zoomControls) {
    zoomControls.remove();
    zoomValueDisplay = null;
  }

  pdfDoc = null;
  pdfPages = [];
  textLayers = [];
  lastHighlightContent = '';
}

// メッセージリスナー
window.addEventListener('message', function (event) {
  console.log('Message received in viewer:', event.data);

  if (!event.data || !event.data.action) return;

  switch (event.data.action) {
    case 'loadPdf':
      loadPdf(event.data.url);
      break;
    case 'highlight':
      highlightContent(event.data.content);
      break;
    case 'clear':
      clearViewer();
      break;
  }
});

// キーボードショートカットのサポート
window.addEventListener('keydown', function (event) {
  // PDFが読み込まれている場合のみショートカットを有効化
  if (!pdfDoc) return;

  // Ctrl/Cmd + '+' でズームイン
  if ((event.ctrlKey || event.metaKey) && event.key === '+') {
    event.preventDefault();
    changeScale(SCALE_STEP);
  }

  // Ctrl/Cmd + '-' でズームアウト
  if ((event.ctrlKey || event.metaKey) && event.key === '-') {
    event.preventDefault();
    changeScale(-SCALE_STEP);
  }

  // Ctrl/Cmd + '0' でズームリセット
  if ((event.ctrlKey || event.metaKey) && event.key === '0') {
    event.preventDefault();
    // 現在のスケールを保存
    const oldScale = scale;
    // デフォルトスケールに戻す
    scale = 1.2;

    if (scale !== oldScale) {
      // ズーム値表示を更新
      if (zoomValueDisplay) {
        zoomValueDisplay.textContent = `${Math.round(scale * 100)}%`;
      }

      // 再レンダリング
      const viewer = document.getElementById('viewer');
      viewer.innerHTML = '';

      // PDFページのクリア
      pdfPages = [];
      textLayers = [];

      // ページを再レンダリング
      const pagesToRender = Math.min(pdfDoc.numPages, 5);
      for (let i = 1; i <= pagesToRender; i++) {
        renderPage(i);
      }

      // ハイライトを再適用
      if (lastHighlightContent) {
        setTimeout(() => highlightContent(lastHighlightContent), 300);
      }
    }
  }
});

// ピンチズームと車輪ズームのサポート
let initialPinchDistance = 0;

// タッチイベントリスナー（ピンチズーム用）
viewerContainer.addEventListener('touchstart', function(e) {
  if (e.touches.length === 2) {
    initialPinchDistance = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
  }
}, false);

viewerContainer.addEventListener('touchmove', function(e) {
  if (e.touches.length === 2 && initialPinchDistance > 0) {
    const currentDistance = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );

    const delta = (currentDistance - initialPinchDistance) / 100;

    if (Math.abs(delta) > 0.05) {
      changeScale(delta);
      initialPinchDistance = currentDistance;
    }

    e.preventDefault(); // ページのスクロールを防止
  }
}, false);

viewerContainer.addEventListener('touchend', function() {
  initialPinchDistance = 0;
}, false);

// マウスホイールによるズーム
viewerContainer.addEventListener('wheel', function(e) {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    const delta = e.deltaY < 0 ? SCALE_STEP : -SCALE_STEP;
    changeScale(delta);
  }
}, { passive: false });

// 初期状態のメッセージを送信
sendStatusMessage('PDF viewer ready');