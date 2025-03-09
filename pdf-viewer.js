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
let scale = 0.5; // デフォルトのスケールを0.5に設定
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

  // すべてのページを再レンダリング
  await renderAllPages();

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

// PDFの読み込み
async function loadPdf(url) {
  console.log('Loading PDF from:', url.substring(0, 50) + '...');

  // 表示状態を更新
  loading.style.display = 'flex';
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

    // すべてのページをレンダリング（Lazy Loadingではなく全ページ読み込み）
    await renderAllPages(loadingText);

    // 表示を更新
    loading.style.display = 'none';
    viewerContainer.style.display = 'block';
    sendStatusMessage(`PDF loaded: All ${pdfDoc.numPages} pages rendered`);

  } catch (err) {
    console.error('Error loading PDF:', err);
    showError(`Failed to load PDF: ${err.message}`);
  }
}

// すべてのページをレンダリング
async function renderAllPages(loadingText) {
  const pagePromises = [];
  const totalPages = pdfDoc.numPages;

  // レンダリング済みのページを追跡するセット
  const renderedPages = new Set();

  // 進捗更新関数
  const updateProgress = (pageNum) => {
    const progress = Math.round((pageNum / totalPages) * 100);
    if (loadingText) {
      loadingText.textContent = `Rendering pages: ${pageNum}/${totalPages} (${progress}%)`;
    }
    sendStatusMessage(`Rendering PDF: ${progress}%`);
  };

  // 各ページのレンダリングを順番に実行
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    try {
      updateProgress(pageNum);
      await renderPage(pageNum);
      renderedPages.add(pageNum);
    } catch (err) {
      console.error(`Error rendering page ${pageNum}:`, err);
    }
  }

  return renderedPages.size;
}

// PDFページのレンダリング (重複を防ぐため改良)
async function renderPage(pageNumber) {
  // すでに同じページ番号のページ要素があるか確認
  const existingPage = document.querySelector(`.page[data-page-number="${pageNumber}"]`);
  if (existingPage) {
    console.log(`Page ${pageNumber} already rendered, skipping`);
    return existingPage;
  }

  try {
    // ページを取得
    const page = await pdfDoc.getPage(pageNumber);

    // すでに同じページが配列に入っていないことを確認
    if (!pdfPages.some(p => p.pageNumber === pageNumber)) {
      pdfPages.push(page);
    }

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

    // ページを順番に追加するための位置計算
    const existingPages = viewer.querySelectorAll('.page');
    let insertBeforeElement = null;

    for (let i = 0; i < existingPages.length; i++) {
      const currentPageNum = parseInt(existingPages[i].dataset.pageNumber);
      if (currentPageNum > pageNumber) {
        insertBeforeElement = existingPages[i];
        break;
      }
    }

    if (insertBeforeElement) {
      viewer.insertBefore(pageContainer, insertBeforeElement);
    } else {
      viewer.appendChild(pageContainer);
    }

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

    // すでに同じページのテキストレイヤーが配列に入っていないことを確認
    if (!textLayers.some(layer => layer.pageNumber === pageNumber)) {
      textLayer.pageNumber = pageNumber;
      textLayers.push(textLayer);
    }

    return textLayerDiv;
  } catch (err) {
    console.error(`Error rendering page ${pageNumber}:`, err);
    sendStatusMessage(`Error rendering page ${pageNumber}: ${err.message}`);
    throw err;
  }
}

// renderTextLayer関数
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

// ハイライトのクリア
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

// テキスト正規化 - 日本語対応強化版
function normalizeText(text) {
  if (!text) return '';

  return text
    .replace(/\s+/g, ' ')  // 連続する空白を単一の空白に
    .replace(/[\n\r\t]/g, ' ')  // 改行やタブを空白に
    .replace(/[　]/g, ' ')  // 全角スペースを半角に
    .replace(/[""]/g, '"')  // 全角引用符を半角に
    .replace(/['']/g, "'")  // 全角アポストロフィを半角に
    .replace(/[！]/g, '!')  // 全角感嘆符を半角に
    .replace(/[？]/g, '?')  // 全角疑問符を半角に
    .replace(/[（]/g, '(')  // 全角括弧を半角に
    .replace(/[）]/g, ')')  // 全角括弧を半角に
    .replace(/[：]/g, ':')  // 全角コロンを半角に
    .trim();  // 前後の空白を削除
}

// ハイライト機能の改善版 - マッチング精度向上とチャンク識別の強化

// ハイライト関数（言語を自動判定）
function highlightContent(content) {
  console.log("Original highlight content:", content);

  // 既存のハイライトを必ずクリア
  clearHighlights();

  if (!content || content.trim() === '') {
    sendStatusMessage('No content to highlight');
    return false;
  }

  if (!pdfDoc || textLayers.length === 0) {
    sendStatusMessage('No PDF loaded to highlight');
    return false;
  }

  // ハイライト内容を保存する前に一度正規化
  lastHighlightContent = content;

  // 言語判定
  const hasJapanese = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf]/g.test(content);

  // デバッグログ
  console.log(`Content length: ${content.length}, Japanese: ${hasJapanese}`);
  console.log(`Content preview: "${content.substring(0, 100)}..."`);

  // 言語に応じた処理を実行
  let result;
  if (hasJapanese) {
    result = highlightJapaneseContent(content);
  } else {
    result = highlightNonJapaneseContent(content);
  }

  return result;
}

// 日本語テキストハイライト改善版
function highlightJapaneseContent(content) {
  // テキストを正規化
  const normalizedContent = normalizeText(content);

  // フィンガープリントを計算（このコンテンツの特徴的な識別子）
  const contentFingerprint = generateContentFingerprint(normalizedContent);
  console.log("Content fingerprint:", contentFingerprint);

  // 文字数に応じてストラテジーを変える
  let searchStrategy;
  if (normalizedContent.length < 30) {
    searchStrategy = "exact_plus_partial";  // 短いテキストは完全一致＋部分一致
  } else if (normalizedContent.length < 100) {
    searchStrategy = "phrase_based";        // 中程度のテキストはフレーズベース
  } else {
    searchStrategy = "segmentation";        // 長いテキストはセグメント分割
  }

  console.log("Using search strategy:", searchStrategy);

  // 日本語テキストから特徴的なフレーズを抽出（改良版）
  const phrases = extractJapanesePhrases(normalizedContent, searchStrategy);
  console.log(`Extracted ${phrases.length} Japanese phrases for matching`);
  phrases.slice(0, 3).forEach((p, i) => console.log(`Phrase ${i+1}: "${p.text}" (weight: ${p.weight})`));

  // ページごとのスコアとハイライト候補を保持する配列
  const pageMatches = [];
  let globalBestScore = 0;

  // 各ページのテキストでマッチング
  textLayers.forEach((layer, pageIndex) => {
    // テキスト要素とページテキストを取得
    const pageTextDivs = layer.textDivs;
    if (!pageTextDivs || pageTextDivs.length === 0) return;

    // ページ全体のテキストを連結
    const pageText = pageTextDivs.map(div => div.textContent || "").join(' ');
    const normalizedPageText = normalizeText(pageText);

    // このページのフィンガープリント
    const pageFingerprint = generateContentFingerprint(normalizedPageText);

    // フィンガープリントの類似度を計算 (初期スコアとして使用)
    const fingerprintSimilarity = compareFingerprints(contentFingerprint, pageFingerprint);
    console.log(`Page ${pageIndex+1} fingerprint similarity: ${fingerprintSimilarity.toFixed(3)}`);

    // 類似度が極端に低いページはスキップ可能 (最適化)
    if (fingerprintSimilarity < 0.1 && normalizedPageText.length > 1000) {
      console.log(`Skipping page ${pageIndex+1} due to low similarity`);
      return;
    }

    // ページのマッチング候補を保持
    const pageMatchCandidates = [];

    // 各フレーズでマッチングを試行
    for (const phrase of phrases) {
      // フレーズの重要度が低すぎる場合はスキップ（最適化）
      if (phrase.weight < 0.3) continue;

      // 検索テキストとフレーズ長に基づいて戦略を選択
      let matches;
      if (searchStrategy === "exact_plus_partial" || phrase.text.length < 15) {
        // 短いフレーズや完全一致が必要な場合は精密な検索
        matches = findExactMatches(phrase.text, normalizedPageText, pageTextDivs, pageIndex);
      } else {
        // 長いフレーズはファジー検索
        matches = findJapanesePhraseMatches(phrase.text, normalizedPageText, pageTextDivs, pageIndex);
      }

      // 検出されたマッチをフレーズの重要度でスコア補正
      matches.forEach(match => {
        match.adjustedScore = match.score * phrase.weight;
        pageMatchCandidates.push(match);
      });

      // 最良のスコアを更新
      const bestMatchInPhrase = matches.reduce((best, match) =>
        match.adjustedScore > best ? match.adjustedScore : best, 0);

      globalBestScore = Math.max(globalBestScore, bestMatchInPhrase);
    }

    // このページのマッチ情報を追加
    if (pageMatchCandidates.length > 0) {
      pageMatches.push({
        pageIndex,
        candidates: pageMatchCandidates,
        bestScore: pageMatchCandidates.reduce((max, m) => Math.max(max, m.adjustedScore), 0)
      });
    }
  });

  // ページスコアによるソート
  pageMatches.sort((a, b) => b.bestScore - a.bestScore);

  // デバッグ情報
  pageMatches.forEach(pm =>
    console.log(`Page ${pm.pageIndex+1}: ${pm.candidates.length} matches, best score: ${pm.bestScore.toFixed(3)}`)
  );

  // 最終的なハイライト対象を選択（重複を避けるアルゴリズム）
  const selectedMatches = selectOptimalMatches(pageMatches, content);
  console.log(`Selected ${selectedMatches.length} matches to highlight`);

  // マッチをハイライト
  let totalHighlighted = 0;
  let bestHighlightedSpan = null;
  let bestHighlightScore = 0;

  // 各マッチに対してハイライトを適用
  selectedMatches.forEach(match => {
    const { pageIndex, startIndex, endIndex, adjustedScore } = match;

    if (pageIndex >= textLayers.length) return;
    const textDivs = textLayers[pageIndex].textDivs;

    // 範囲を調整（文脈を含める）
    const contextSize = Math.max(1, Math.min(3, Math.floor(textDivs.length * 0.01)));
    const startSpanIndex = Math.max(0, startIndex - contextSize);
    const endSpanIndex = Math.min(textDivs.length - 1, endIndex + contextSize);

    // ハイライトを適用
    const spans = highlightSpanRange(textDivs, startSpanIndex, endSpanIndex, adjustedScore);
    totalHighlighted += spans.length;

    // 最良のハイライトを記録
    if (adjustedScore > bestHighlightScore && spans.length > 0) {
      bestHighlightScore = adjustedScore;
      bestHighlightedSpan = spans[0];
    }
  });

  // 結果のレポート
  if (bestHighlightedSpan) {
    bestHighlightedSpan.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });
    sendStatusMessage(`Highlighted text with ${Math.round(bestHighlightScore * 100)}% match (${totalHighlighted} spans)`);
    return true;
  } else if (totalHighlighted > 0) {
    sendStatusMessage(`Found ${totalHighlighted} matching spans`);
    return true;
  } else {
    // バックアップ: 特徴的な文字でマッチング
    const backupHighlights = performJapaneseCharacterMatchingV2(normalizedContent);
    if (backupHighlights > 0) {
      sendStatusMessage(`Found ${backupHighlights} partial character matches`);
      return true;
    } else {
      sendStatusMessage('No similar text found in document');
      console.log('No matches found. Text significantly differs from PDF content.');
      return false;
    }
  }
}

// コンテンツのフィンガープリントを生成
function generateContentFingerprint(text) {
  // 1. 特徴的な文字種の分布
  const charTypes = {
    kanji: 0,      // 漢字
    hiragana: 0,   // ひらがな
    katakana: 0,   // カタカナ
    digit: 0,      // 数字
    ascii: 0,      // ASCII文字
    other: 0       // その他
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const code = char.charCodeAt(0);

    if (code >= 0x4e00 && code <= 0x9faf) charTypes.kanji++;
    else if (code >= 0x3040 && code <= 0x309f) charTypes.hiragana++;
    else if (code >= 0x30a0 && code <= 0x30ff) charTypes.katakana++;
    else if (code >= 0x30 && code <= 0x39) charTypes.digit++;
    else if (code >= 0x20 && code <= 0x7e) charTypes.ascii++;
    else charTypes.other++;
  }

  // 文字比率を計算
  const total = Object.values(charTypes).reduce((sum, val) => sum + val, 0) || 1;
  const charRatios = {};
  for (const type in charTypes) {
    charRatios[type] = charTypes[type] / total;
  }

  // 2. 特徴的な文字グループを抽出
  const kanjiGroups = (text.match(/[\u4e00-\u9faf]{2,}/g) || [])
    .filter(g => g.length >= 2)
    .slice(0, 10);

  const katakanaGroups = (text.match(/[\u30a0-\u30ff]{3,}/g) || [])
    .filter(g => g.length >= 3)
    .slice(0, 5);

  const numberGroups = (text.match(/[0-9０-９]{2,}|[0-9０-９][年月日円％]/g) || [])
    .slice(0, 5);

  // 3. バイグラム頻度（隣接する2文字の出現頻度）
  const bigrams = {};
  for (let i = 0; i < text.length - 1; i++) {
    const bigram = text.substring(i, i + 2);
    bigrams[bigram] = (bigrams[bigram] || 0) + 1;
  }

  // トップ15の頻出バイグラム
  const topBigrams = Object.entries(bigrams)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([bigram]) => bigram);

  // フィンガープリントを返す
  return {
    length: text.length,
    charRatios,
    kanjiGroups,
    katakanaGroups,
    numberGroups,
    topBigrams
  };
}

// フィンガープリントの類似度を比較
function compareFingerprints(fp1, fp2) {
  if (!fp1 || !fp2) return 0;

  // 1. 文字種比率の類似度 (0.0-1.0)
  let charRatioSimilarity = 0;
  for (const type in fp1.charRatios) {
    const diff = Math.abs(fp1.charRatios[type] - (fp2.charRatios[type] || 0));
    charRatioSimilarity += (1 - diff);
  }
  charRatioSimilarity /= Object.keys(fp1.charRatios).length;

  // 2. 特徴的なグループの一致度
  const kanjiMatch = countCommonElements(fp1.kanjiGroups, fp2.kanjiGroups) /
    Math.max(1, Math.min(fp1.kanjiGroups.length, fp2.kanjiGroups.length));

  const katakanaMatch = countCommonElements(fp1.katakanaGroups, fp2.katakanaGroups) /
    Math.max(1, Math.min(fp1.katakanaGroups.length, fp2.katakanaGroups.length));

  const numberMatch = countCommonElements(fp1.numberGroups, fp2.numberGroups) /
    Math.max(1, Math.min(fp1.numberGroups.length, fp2.numberGroups.length));

  // 3. バイグラムの一致度
  const bigramMatch = countCommonElements(fp1.topBigrams, fp2.topBigrams) /
    Math.max(1, Math.min(fp1.topBigrams.length, fp2.topBigrams.length));

  // 重み付け合計 (1.0が完全一致)
  return 0.3 * charRatioSimilarity +
         0.3 * (kanjiMatch * 0.6 + katakanaMatch * 0.3 + numberMatch * 0.1) +
         0.4 * bigramMatch;
}

// 配列の共通要素数をカウント
function countCommonElements(arr1, arr2) {
  if (!arr1 || !arr2) return 0;
  const set1 = new Set(arr1);
  return arr2.filter(item => set1.has(item)).length;
}

// 日本語のフレーズ抽出（改良版）
function extractJapanesePhrases(text, strategy) {
  const phrases = [];

  if (strategy === "exact_plus_partial") {
    // 短いコンテンツなら全体をそのまま高重要度で使用
    phrases.push({ text: text, weight: 1.0 });

    // 特徴的な文字の組み合わせも追加
    extractSignificantCharacterGroups(text).forEach(group => {
      phrases.push({ text: group, weight: 0.7 });
    });

    return phrases;
  }

  // 文に分割（日本語の句点を考慮）
  const sentences = text.split(/(?<=[。．.!?！？])\s*/);

  if (strategy === "phrase_based") {
    // 各文をそのまま使用
    sentences.forEach(sentence => {
      sentence = sentence.trim();
      if (sentence.length < 5) return; // 極端に短い文は無視

      // 文の長さに応じた重み付け
      const sentenceWeight = Math.min(1.0, 0.5 + (sentence.length / 50));
      phrases.push({ text: sentence, weight: sentenceWeight });
    });

    // 特徴的な文字グループも追加
    extractSignificantCharacterGroups(text).forEach(group => {
      phrases.push({ text: group, weight: 0.6 });
    });
  }
  else if (strategy === "segmentation") {
    // 長い文章の場合、文を適切なサイズに分割
    sentences.forEach(sentence => {
      sentence = sentence.trim();
      if (sentence.length < 5) return;

      // 長い文は複数のフレーズに分割
      if (sentence.length > 100) {
        // 60-80文字程度でオーバーラップしながら分割
        for (let i = 0; i < sentence.length; i += 60) {
          const segmentEnd = Math.min(i + 80, sentence.length);
          const segment = sentence.substring(i, segmentEnd);
          if (segment.length >= 20) {
            // 開始位置に応じた重み付け（文の先頭ほど重要）
            const positionWeight = Math.max(0.6, 1.0 - (i / sentence.length / 2));
            phrases.push({ text: segment, weight: positionWeight });
          }
        }
      }
      else {
        // 短い文はそのまま使用
        phrases.push({ text: sentence, weight: 0.9 });
      }
    });

    // 1. 特徴的な文字グループを追加
    extractSignificantCharacterGroups(text).forEach(group => {
      phrases.push({ text: group, weight: 0.5 });
    });

    // 2. 重要な節を抽出（助詞「は」「が」「を」前後などの重要な部分）
    const importantPhrases = extractImportantJapanesePhrases(text);
    importantPhrases.forEach(phrase => {
      if (phrase.length >= 10) {
        phrases.push({ text: phrase, weight: 0.7 });
      }
    });
  }

  // 重複排除
  return [...new Map(phrases.map(item => [item.text, item])).values()];
}

// 重要な日本語のフレーズを抽出（助詞の前後など）
function extractImportantJapanesePhrases(text) {
  const phrases = [];

  // 重要な助詞とその前後のフレーズを抽出
  const particlePatterns = [
    /(.{5,20}[はがを])(.{5,20})/g,
    /(.{5,15})(という.{5,15})/g,
    /(.{5,15})(において.{5,15})/g
  ];

  particlePatterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1]) phrases.push(match[1]);
      if (match[2]) phrases.push(match[2]);
      if (match[1] && match[2]) phrases.push(match[1] + match[2]);
    }
  });

  // 重要な構文パターンを探す
  const syntaxPatterns = [
    /(.{5,25})(とは|について|によって|によると)/g,
    /(「.{5,30}」)/g
  ];

  syntaxPatterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      for (let i = 1; i < match.length; i++) {
        if (match[i] && match[i].length >= 5) {
          phrases.push(match[i]);
        }
      }
    }
  });

  return [...new Set(phrases)];
}

// 特徴的な文字グループを抽出
function extractSignificantCharacterGroups(text) {
  const groups = [];

  // 1. 漢字の連続 (2文字以上)
  const kanjiGroups = text.match(/[\u4e00-\u9faf]{2,}/g) || [];
  kanjiGroups.forEach(group => {
    if (group.length >= 2) groups.push(group);
  });

  // 2. カタカナの連続 (3文字以上、外来語や固有名詞)
  const katakanaGroups = text.match(/[\u30a0-\u30ff]{3,}/g) || [];
  katakanaGroups.forEach(group => {
    if (group.length >= 3) groups.push(group);
  });

  // 3. 数字を含む特徴的な表現
  const numberGroups = text.match(/[0-9０-９]{2,}|[0-9０-９][年月日円％]/g) || [];
  numberGroups.forEach(group => groups.push(group));

  // 不要なグループを除外して返す
  return groups.filter(group => {
    // 一般的すぎる表現を除外
    const commonExprs = ['これは', 'それは', 'ことが', 'ための'];
    return !commonExprs.includes(group);
  });
}

// 完全一致検索（短いフレーズ用）
function findExactMatches(phrase, text, textDivs, pageIndex) {
  const matches = [];

  // 完全一致の場合
  let pos = text.indexOf(phrase);
  while (pos !== -1) {
    // このマッチに対応するスパンインデックスを特定
    const spanIndices = identifySpansForTextSegment(pos, pos + phrase.length, text, textDivs);

    // 完全一致は高いスコアを与える
    matches.push({
      pageIndex,
      startIndex: spanIndices.startIndex,
      endIndex: spanIndices.endIndex,
      score: 1.0,
      phrase,
      exactMatch: true
    });

    // 次のマッチを検索
    pos = text.indexOf(phrase, pos + 1);
  }

  // 部分一致も確認（5文字以上のフレーズのみ）
  if (phrase.length >= 5 && matches.length === 0) {
    // 1. フレーズを分割して部分マッチングを試みる
    const minLength = Math.max(5, Math.floor(phrase.length * 0.5));

    for (let i = 0; i <= phrase.length - minLength; i++) {
      const subPhrase = phrase.substring(i, i + minLength);
      let subPos = text.indexOf(subPhrase);

      while (subPos !== -1) {
        // このマッチに対応するスパンインデックスを特定
        const spanIndices = identifySpansForTextSegment(subPos, subPos + subPhrase.length, text, textDivs);

        // 部分一致のスコアはフレーズ長に比例
        const score = 0.5 + 0.3 * (subPhrase.length / phrase.length);

        matches.push({
          pageIndex,
          startIndex: spanIndices.startIndex,
          endIndex: spanIndices.endIndex,
          score,
          phrase: subPhrase,
          exactMatch: false,
          originalPhrase: phrase
        });

        // 次のマッチを検索
        subPos = text.indexOf(subPhrase, subPos + 1);
      }
    }
  }

  return matches;
}

// 日本語向けフレーズマッチング（改良版）
function findJapanesePhraseMatches(phrase, text, textDivs, pageIndex) {
  const matches = [];

  // 短いフレーズなら完全一致を試みる
  if (phrase.length < 15) {
    return findExactMatches(phrase, text, textDivs, pageIndex);
  }

  // スライディングウィンドウのサイズとステップサイズを決定
  const windowSize = Math.min(phrase.length * 2, 300);
  const stepSize = Math.max(5, Math.floor(windowSize / 6)); // 細かいステップで詳細に検索

  // 最良スコアとウィンドウを追跡
  let bestScore = 0;
  let bestWindow = null;
  let bestPos = -1;

  // テキスト全体に対してスライディングウィンドウで検索
  for (let i = 0; i < text.length - windowSize; i += stepSize) {
    const window = text.substring(i, i + windowSize);

    // 日本語に適したスコアリング
    const score = calculateJapanesePhraseScore(phrase, window);

    // しきい値以上のスコアのみ記録
    if (score > 0.4) {
      // 最良のマッチを更新
      if (score > bestScore) {
        bestScore = score;
        bestWindow = window;
        bestPos = i;
      }

      // テキストウィンドウに対応するスパンを特定
      const spanIndices = identifySpansForTextSegment(i, i + windowSize, text, textDivs);

      matches.push({
        pageIndex,
        startIndex: spanIndices.startIndex,
        endIndex: spanIndices.endIndex,
        score,
        phrase,
        window
      });
    }
  }

  // マッチがなければ、最良の部分一致を試みる
  if (matches.length === 0) {
    // フレーズを複数部分に分けて再検索
    const segmentSize = Math.floor(phrase.length / 2);

    for (let i = 0; i < phrase.length - segmentSize; i += segmentSize / 2) {
      const segment = phrase.substring(i, i + segmentSize);
      const segmentMatches = findExactMatches(segment, text, textDivs, pageIndex);

      segmentMatches.forEach(match => {
        // スコアを調整（部分一致であることを示す）
        match.score *= 0.7;
        match.partialMatch = true;
        matches.push(match);
      });
    }
  }

  return matches;
}

// 日本語フレーズスコアリング（改良版）
function calculateJapanesePhraseScore(phrase, window) {
  // 完全一致チェック
  if (window.includes(phrase)) {
    return 1.0;
  }

  // 最長共通部分文字列の長さを取得
  const longestCommon = longestCommonSubstring(phrase, window);
  const lcsScore = longestCommon.length / phrase.length;

  // n-gram ベースの部分一致（日本語に効果的）
  // 特に漢字・カタカナなどの特徴的な文字を強化
  const ngramScore = calculateEnhancedNgramSimilarity(phrase, window);

  // 特徴的な文字（漢字やカタカナなど）の一致度
  const characteristicScore = calculateCharacteristicMatch(phrase, window);

  // 文字をn-gram分割して類似度を計算（改良版）
  function calculateEnhancedNgramSimilarity(str1, str2) {
    // 文字種ごとの重み付けを導入
    function getCharWeight(char) {
      const code = char.charCodeAt(0);
      // 漢字は最も重要
      if (code >= 0x4e00 && code <= 0x9faf) return 2.0;
      // カタカナも重要（固有名詞などに使われる）
      if (code >= 0x30a0 && code <= 0x30ff) return 1.5;
      // 数字も重要な情報
      if (code >= 0x30 && code <= 0x39) return 1.5;
      // その他は通常の重み
      return 1.0;
    }

    // n=2 で文字を分割
    function extractWeightedBigrams(text) {
      const grams = {};
      let totalWeight = 0;

      for (let i = 0; i < text.length - 1; i++) {
        const gram = text.substring(i, i + 2);
        const weight = getCharWeight(text[i]) * getCharWeight(text[i+1]);
        grams[gram] = (grams[gram] || 0) + weight;
        totalWeight += weight;
      }

      return { grams, totalWeight };
    }

    const { grams: grams1, totalWeight: weight1 } = extractWeightedBigrams(str1);
    const { grams: grams2, totalWeight: weight2 } = extractWeightedBigrams(str2);

    // 共通するn-gramの重みを合計
    let commonWeight = 0;

    for (const gram in grams1) {
      if (grams2[gram]) {
        commonWeight += Math.min(grams1[gram], grams2[gram]);
      }
    }

    // Jaccard係数に類似した類似度スコア
    return commonWeight / (weight1 + weight2 - commonWeight);
  }

  // 重み付けした合計スコア
  return 0.4 * lcsScore + 0.4 * ngramScore + 0.2 * characteristicScore;
}

// 最適なマッチの組み合わせを選択
function selectOptimalMatches(pageMatches, originalContent) {
  // 最終的に選択するマッチのリスト
  const selectedMatches = [];

  // 各ページの候補をスコア順にソート
  pageMatches.forEach(pm => {
    pm.candidates.sort((a, b) => b.adjustedScore - a.adjustedScore);
  });

  // 1. トップスコアのページから最良のマッチを選択
  if (pageMatches.length > 0) {
    const bestPage = pageMatches[0];

    // そのページから最良のマッチを選択（上位3つまで）
    for (let i = 0; i < Math.min(3, bestPage.candidates.length); i++) {
      if (bestPage.candidates[i].adjustedScore > 0.6) {
        selectedMatches.push(bestPage.candidates[i]);
      }
    }
  }

  // 2. 他のページからもスコアの高いマッチを追加（最大2ページまで）
  const otherPages = pageMatches.slice(1, 3);
  otherPages.forEach(page => {
    // 各ページから最高スコアのマッチを1つだけ選択
    if (page.candidates.length > 0 && page.candidates[0].adjustedScore > 0.7) {
      selectedMatches.push(page.candidates[0]);
    }
  });

  // 3. 重複するマッチを統合または削除
  const filteredMatches = [];
  const coveredSpans = new Set();

  selectedMatches.sort((a, b) => b.adjustedScore - a.adjustedScore);

  for (const match of selectedMatches) {
    // このマッチのスパン範囲を文字列化
    const spanKey = getSpanRangeKey(match);

    // 既に選択した範囲と重複していないか確認
    if (!isSignificantlyOverlapping(match, coveredSpans)) {
      filteredMatches.push(match);

      // 選択したスパンを記録
      for (let i = match.startIndex; i <= match.endIndex; i++) {
        coveredSpans.add(`${match.pageIndex}-${i}`);
      }
    }
  }

  // 改善：もしも一つもマッチが選択されなかった場合は、最低1つは選択する
  if (filteredMatches.length === 0 && selectedMatches.length > 0) {
    filteredMatches.push(selectedMatches[0]);
  }

  return filteredMatches;
}

// スパン範囲の文字列表現を取得
function getSpanRangeKey(match) {
  return `${match.pageIndex}-${match.startIndex}-${match.endIndex}`;
}

// 有意な重複があるか確認
function isSignificantlyOverlapping(match, coveredSpans) {
  let overlapCount = 0;
  const totalSpans = match.endIndex - match.startIndex + 1;

  for (let i = match.startIndex; i <= match.endIndex; i++) {
    if (coveredSpans.has(`${match.pageIndex}-${i}`)) {
      overlapCount++;
    }
  }

  // 50%以上の重複があれば有意と判断
  return (overlapCount / totalSpans) > 0.5;
}

// バックアップ: 日本語文字ベースのマッチング（改良版）
function performJapaneseCharacterMatchingV2(normalizedContent) {
  console.log("Using improved Japanese character-based matching as fallback");

  // 特徴的な文字グループを抽出
  const charGroups = extractSignificantCharacterGroups(normalizedContent);
  console.log(`Extracted ${charGroups.length} significant character groups`);

  // 特に重要な文字グループを特定（長さや文字種で判断）
  const priorityGroups = charGroups
    .filter(group => {
      // 漢字が含まれるグループを優先
      const hasKanji = /[\u4e00-\u9faf]/.test(group);
      // より長いグループを優先
      return hasKanji && group.length >= 2;
    })
    .sort((a, b) => b.length - a.length)
    .slice(0, 10);

  console.log("Priority character groups:", priorityGroups);

  // バイグラム（2文字連続）を抽出して重要度スコアリング
  const bigrams = {};

  for (let i = 0; i < normalizedContent.length - 1; i++) {
    const bigram = normalizedContent.substring(i, i + 2);

    // 空白を含むものは無視
    if (bigram.trim().length !== 2) continue;

    // 漢字を含むバイグラムは高いスコア
    const hasKanji = /[\u4e00-\u9faf]/.test(bigram);
    const score = hasKanji ? 2.0 : 1.0;

    bigrams[bigram] = (bigrams[bigram] || 0) + score;
  }

  // 重要度順にソート
  const topBigrams = Object.entries(bigrams)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([gram]) => gram);

  console.log("Top bigrams:", topBigrams);

  // 各ページで文字グループとバイグラムのマッチを試みる
  let totalHighlights = 0;

  textLayers.forEach((layer, pageIndex) => {
    const textDivs = layer.textDivs;

    // 各スパンをチェック
    for (let i = 0; i < textDivs.length; i++) {
      const span = textDivs[i];
      const spanText = normalizeText(span.textContent);
      let matched = false;

      // 1. 優先グループでのマッチング
      for (const group of priorityGroups) {
        if (spanText.includes(group)) {
          matched = true;
          // 長いグループほど高いスコア
          const score = 0.5 + Math.min(0.3, group.length * 0.05);

          span.classList.add('highlight');
          span.classList.add('highlight-medium');
          span.style.backgroundColor = 'rgba(255, 207, 51, 0.75)';

          totalHighlights++;
          break;
        }
      }

      // 2. まだマッチしていなければバイグラムでチェック
      if (!matched) {
        for (const bigram of topBigrams) {
          if (spanText.includes(bigram)) {
            span.classList.add('highlight');
            span.classList.add('highlight-low');
            span.style.backgroundColor = 'rgba(255, 237, 102, 0.65)';

            totalHighlights++;
            break;
          }
        }
      }
    }
  });

  return totalHighlights;
}

// 非日本語テキストのハイライト処理
function highlightNonJapaneseContent(content) {
  // 既存のハイライトをクリア
  clearHighlights();

  if (!content || content.trim() === '') {
    sendStatusMessage('No content to highlight');
    return false;
  }

  if (!pdfDoc || textLayers.length === 0) {
    sendStatusMessage('No PDF loaded to highlight');
    return false;
  }

  // ハイライト内容を保存
  lastHighlightContent = content;

  // テキストを正規化
  const normalizedContent = normalizeText(content);

  // フィンガープリントを計算
  const contentFingerprint = generateNonJapaneseFingerprint(normalizedContent);

  // フレーズを抽出
  const phrases = extractSignificantPhrases(normalizedContent);
  console.log(`Extracted ${phrases.length} significant phrases for matching`);
  phrases.forEach((phrase, i) => {
    if (i < 3) console.log(`Phrase ${i+1}: "${phrase}"`);
  });

  // 各ページで検索
  let bestMatches = [];
  let globalBestScore = 0;
  let allMatches = [];

  // 各ページのテキストを収集
  textLayers.forEach((layer, pageIndex) => {
    // このページのすべてのテキストを取得
    const pageTextDivs = layer.textDivs;
    const pageText = pageTextDivs.map(div => div.textContent).join(' ');
    const normalizedPageText = normalizeText(pageText);

    // このページのフィンガープリント
    const pageFingerprint = generateNonJapaneseFingerprint(normalizedPageText);

    // フィンガープリントの類似度を計算
    const fingerprintSimilarity = compareNonJapaneseFingerprints(contentFingerprint, pageFingerprint);
    console.log(`Page ${pageIndex+1} fingerprint similarity: ${fingerprintSimilarity.toFixed(3)}`);

    // 類似度が極端に低いページはスキップ可能 (最適化)
    if (fingerprintSimilarity < 0.1 && normalizedPageText.length > 1000) {
      console.log(`Skipping page ${pageIndex+1} due to low similarity`);
      return;
    }

    // 各フレーズに対してマッチングを実行
    for (const phrase of phrases) {
      if (phrase.length < 15) continue; // 極端に短いフレーズは飛ばす

      // このフレーズのマッチを探す
      const matches = findPhraseMatches(phrase, normalizedPageText, pageTextDivs, pageIndex);

      // スコアが閾値以上のマッチをすべて記録
      matches.filter(match => match.score > 0.5).forEach(match => {
        allMatches.push(match);

        // 最良のマッチを追跡
        if (match.score > globalBestScore) {
          globalBestScore = match.score;
        }
      });
    }
  });

  // スコアでソート
  allMatches.sort((a, b) => b.score - a.score);

  // 重複を排除して上位のマッチを選択
  bestMatches = selectBestMatches(allMatches);

  console.log(`Selected ${bestMatches.length} best matches to highlight`);

  // マッチしたテキストをハイライト
  let highlightedCount = 0;
  let bestHighlightedSpan = null;

  for (const match of bestMatches) {
    const { pageIndex, startIndex, endIndex, score } = match;

    // テキスト要素を取得
    if (pageIndex < textLayers.length) {
      const textDivs = textLayers[pageIndex].textDivs;

      // 範囲を調整（前後に文脈を追加）
      const startSpanIndex = Math.max(0, startIndex - 1);
      const endSpanIndex = Math.min(textDivs.length - 1, endIndex + 1);

      // ハイライトを適用
      const highlightedSpans = highlightSpanRange(textDivs, startSpanIndex, endSpanIndex, score);
      highlightedCount += highlightedSpans.length;

      // 最良のハイライトを記録（自動スクロール用）
      if (score >= globalBestScore * 0.95 && !bestHighlightedSpan && highlightedSpans.length > 0) {
        bestHighlightedSpan = highlightedSpans[0];
      }
    }
  }

  // 結果を表示
  if (bestHighlightedSpan) {
    // 最良のマッチにスクロール
    bestHighlightedSpan.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });
    sendStatusMessage(`Text highlighted with ${Math.round(globalBestScore * 100)}% match (${highlightedCount} spans)`);
    return true;
  } else if (highlightedCount > 0) {
    sendStatusMessage(`Found ${highlightedCount} text matches`);
    return true;
  } else {
    // バックアップ：部分単語マッチングを試行
    highlightedCount = performPartialWordMatchingV2(normalizedContent);

    if (highlightedCount > 0) {
      sendStatusMessage(`Found ${highlightedCount} partial matches`);
      return true;
    } else {
      sendStatusMessage('No similar text found in document');
      console.log('No matches found. Text might be significantly different from the content in PDF.');
      return false;
    }
  }
}

// 英語・非日本語向けフィンガープリント生成
function generateNonJapaneseFingerprint(text) {
  // 単語の頻度分析
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
  const wordFreq = {};
  words.forEach(word => {
    wordFreq[word] = (wordFreq[word] || 0) + 1;
  });

  // 文字種の分布
  const charTypes = {
    letter: 0,
    digit: 0,
    punctuation: 0,
    other: 0
  };

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      charTypes.letter++;
    } else if (code >= 48 && code <= 57) {
      charTypes.digit++;
    } else if ((code >= 33 && code <= 47) || (code >= 58 && code <= 64) ||
               (code >= 91 && code <= 96) || (code >= 123 && code <= 126)) {
      charTypes.punctuation++;
    } else {
      charTypes.other++;
    }
  }

  // 最も頻出する単語
  const topWords = Object.entries(wordFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([word]) => word);

  // 文字のバイグラム頻度
  const bigrams = {};
  for (let i = 0; i < text.length - 1; i++) {
    const bigram = text.substring(i, i + 2).toLowerCase();
    if (bigram.match(/[a-z]{2}/)) {
      bigrams[bigram] = (bigrams[bigram] || 0) + 1;
    }
  }

  const topBigrams = Object.entries(bigrams)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([gram]) => gram);

  return {
    length: text.length,
    charTypes,
    topWords,
    topBigrams
  };
}

// 非日本語フィンガープリントの比較
function compareNonJapaneseFingerprints(fp1, fp2) {
  if (!fp1 || !fp2) return 0;

  // 1. 文書長の類似度
  const lengthRatio = Math.min(fp1.length, fp2.length) / Math.max(fp1.length, fp2.length);

  // 2. 文字種分布の類似度
  let charTypeSimilarity = 0;
  let totalChars1 = 0;
  let totalChars2 = 0;

  for (const type in fp1.charTypes) {
    totalChars1 += fp1.charTypes[type];
    totalChars2 += fp2.charTypes[type];
  }

  for (const type in fp1.charTypes) {
    const ratio1 = fp1.charTypes[type] / totalChars1;
    const ratio2 = fp2.charTypes[type] / totalChars2;
    charTypeSimilarity += (1 - Math.abs(ratio1 - ratio2));
  }
  charTypeSimilarity /= Object.keys(fp1.charTypes).length;

  // 3. 単語の一致度
  const wordMatch = countCommonElements(fp1.topWords, fp2.topWords) /
    Math.max(1, Math.min(fp1.topWords.length, fp2.topWords.length));

  // 4. バイグラムの一致度
  const bigramMatch = countCommonElements(fp1.topBigrams, fp2.topBigrams) /
    Math.max(1, Math.min(fp1.topBigrams.length, fp2.topBigrams.length));

  // 総合スコア
  return 0.1 * lengthRatio + 0.2 * charTypeSimilarity + 0.4 * wordMatch + 0.3 * bigramMatch;
}

// 改良版部分単語マッチング
function performPartialWordMatchingV2(normalizedContent) {
  console.log("Using improved partial word matching as fallback");

  // 重要な単語を抽出 (3文字以上)
  const contentWords = normalizedContent.split(/\s+/)
    .filter(word => word.length >= 3)
    .map(word => word.toLowerCase());

  // 一般的な単語を除外
  const stopWords = ['the', 'and', 'that', 'this', 'with', 'from', 'have', 'been', 'were', 'they', 'their', 'what', 'when', 'where', 'which'];
  const importantWords = contentWords.filter(word => !stopWords.includes(word));

  // 単語の頻度と長さを考慮したスコアリング
  const wordScores = {};

  importantWords.forEach(word => {
    // 基本スコア = 頻度
    wordScores[word] = (wordScores[word] || 0) + 1;

    // 長い単語にボーナス
    if (word.length >= 6) wordScores[word] += 0.5;
    if (word.length >= 9) wordScores[word] += 0.5;

    // 大文字から始まる単語（固有名詞の可能性）にボーナス
    if (/^[A-Z]/.test(word)) wordScores[word] += 1;

    // 数字を含む単語にボーナス（日付や数値などの可能性）
    if (/\d/.test(word)) wordScores[word] += 1;
  });

  // 重要単語をスコア順にソート
  const sortedWords = Object.entries(wordScores)
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word);

  // 上位20語を選択
  const selectedWords = sortedWords.slice(0, 20);
  console.log("Selected important words:", selectedWords);

  // 各ページで単語マッチを試みる
  let totalHighlights = 0;

  textLayers.forEach((layer, pageIndex) => {
    const textDivs = layer.textDivs;

    // 各スパンをチェック
    for (let i = 0; i < textDivs.length; i++) {
      const span = textDivs[i];
      const spanText = normalizeText(span.textContent).toLowerCase();

      // 各重要単語について完全一致の確認
      for (const word of selectedWords) {
        // 単語の境界を考慮した検索パターン
        const pattern = new RegExp(`\\b${word}\\b`, 'i');

        if (pattern.test(spanText)) {
          // スコア計算（単語長と重要度に基づく）
          const wordIndex = selectedWords.indexOf(word);
          const wordImportance = 1 - (wordIndex / selectedWords.length);
          const score = 0.5 + (0.2 * wordImportance) + (0.3 * Math.min(word.length / 10, 0.3));

          // ハイライトを適用
          span.classList.add('highlight');

          // スコアに応じたハイライトクラスを追加
          if (score >= 0.7) {
            span.classList.add('highlight-medium');
            span.style.backgroundColor = 'rgba(255, 207, 51, 0.75)';
          } else {
            span.classList.add('highlight-low');
            span.style.backgroundColor = 'rgba(255, 237, 102, 0.65)';
          }

          totalHighlights++;
          break; // 一つの単語が見つかれば十分
        }
      }
    }
  });

  return totalHighlights;
}

// テキストセグメントに対応するスパンインデックスを特定
function identifySpansForTextSegment(startOffset, endOffset, text, textDivs) {
  let startIndex = 0;
  let endIndex = textDivs.length - 1;
  let currentOffset = 0;

  // スタート位置を見つける
  for (let i = 0; i < textDivs.length; i++) {
    const divLength = (textDivs[i].textContent || "").length + 1; // +1 for space
    if (currentOffset + divLength > startOffset) {
      startIndex = i;
      break;
    }
    currentOffset += divLength;
  }

  // 終了位置を見つける
  currentOffset = 0; // リセット
  for (let i = 0; i < textDivs.length; i++) {
    const divLength = (textDivs[i].textContent || "").length + 1;
    currentOffset += divLength;
    if (currentOffset >= endOffset) {
      endIndex = i;
      break;
    }
  }

  // 範囲が逆転していないか確認
  if (startIndex > endIndex) {
    // スタートとエンドが逆になっていたら修正
    console.warn(`Invalid span range detected: ${startIndex} > ${endIndex}, fixing...`);
    // より安全な範囲に修正
    endIndex = Math.min(startIndex + 5, textDivs.length - 1);
  }

  return { startIndex, endIndex };
}

// 最長共通部分文字列を見つける
function longestCommonSubstring(str1, str2) {
  if (!str1 || !str2) return '';

  // 動的計画法のテーブルを用意
  const matrix = Array(str1.length + 1).fill().map(() => Array(str2.length + 1).fill(0));

  // 最長の共通部分文字列の長さと終了位置
  let maxLength = 0;
  let endPos = 0;

  // 表を埋める
  for (let i = 1; i <= str1.length; i++) {
    for (let j = 1; j <= str2.length; j++) {
      if (str1[i-1] === str2[j-1]) {
        // 連続する一致を追跡
        matrix[i][j] = matrix[i-1][j-1] + 1;

        // 最長の共通部分文字列を更新
        if (matrix[i][j] > maxLength) {
          maxLength = matrix[i][j];
          endPos = i;
        }
      }
    }
  }

  // 最長共通部分文字列を取り出す
  return str1.substring(endPos - maxLength, endPos);
}

// 特徴的な文字（漢字・カタカナなど）の一致度を計算
function calculateCharacteristicMatch(phrase, window) {
  // 特徴的な文字を抽出（漢字・カタカナ・数字）
  function extractCharacteristicChars(text) {
    const chars = {};
    // 漢字、カタカナ、数字を抽出
    const regex = /[\u4e00-\u9faf\u30a0-\u30ff\d]/g;
    let match;

    while ((match = regex.exec(text)) !== null) {
      chars[match[0]] = (chars[match[0]] || 0) + 1;
    }

    return chars;
  }

  // 入力チェック
  if (!phrase || !window) return 0;

  const chars1 = extractCharacteristicChars(phrase);
  const chars2 = extractCharacteristicChars(window);

  // 文字数をカウント
  let phraseCharCount = 0;
  let matchedCharCount = 0;

  for (const char in chars1) {
    phraseCharCount += chars1[char];
    if (chars2[char]) {
      matchedCharCount += Math.min(chars1[char], chars2[char]);
    }
  }

  // 0除算を防止
  return phraseCharCount > 0 ? matchedCharCount / phraseCharCount : 0;
}

// ビューアーのクリア
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
      renderAllPages();

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