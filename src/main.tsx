import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { T1Wysiwyg } from './t1/T1Wysiwyg';
import { T2Budoux } from './t2/T2Budoux';
import { ReviewScreen } from './review/ReviewScreen';
import './index.css';

// 検証用モードは同じバンドルに同居させる。
// 別ページにすると「本番と同じビルド経路を通っているか」が怪しくなるため。
const mode = new URLSearchParams(location.search).get('mode');

function Root() {
  if (mode === 't1') return <T1Wysiwyg />;
  if (mode === 't2') return <T2Budoux />;
  // モックデータでレビューUIの操作感だけ見たいとき
  if (mode === 'review-demo') return <ReviewScreen />;
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
