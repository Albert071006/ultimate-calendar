import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { resolveConnection } from './client-context';

const container = document.getElementById('root');
if (!container) throw Error('缺少应用容器');
document.title = '终极日历本地版';
const desktop = resolveConnection({});
createRoot(container).render(desktop.client
  ? <App client={desktop.client} host={desktop.host} />
  : <main role="alert" style={{ padding: 32 }}><h1>本地日历未能启动</h1><p>请退出后重新打开桌面应用。若仍然出现此提示，请重新安装本地版；已有资料请保留。</p></main>);
