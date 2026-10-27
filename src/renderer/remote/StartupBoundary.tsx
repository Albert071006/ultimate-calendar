import { Component, type ReactNode } from 'react';

/** A failed mobile render must leave a recovery route without touching private browser storage. */
export class StartupBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    if (!this.state.failed) return this.props.children;
    return <main role="alert" style={{ boxSizing: 'border-box', minHeight: '100dvh', padding: '80px 28px', background: '#f5f0e6', color: '#29251e', font: '16px/1.7 system-ui, sans-serif' }}>
      <h1 style={{ margin: '0 0 12px', fontSize: 24 }}>日历暂时没有打开</h1>
      <p>请重新载入；如果仍不能打开，请反馈下面的诊断代码。</p>
      <a href="/?recovery=render" style={{ display: 'inline-block', padding: '10px 18px', border: '1px solid #bdb5a5', borderRadius: 12, color: 'inherit', textDecoration: 'none' }}>重新载入日历</a>
      <p style={{ color: '#726b60', fontSize: 14 }}>重新载入不会清除配对、日历或待提交修改。</p>
      <small style={{ color: '#726b60' }}>诊断代码：UC-RENDER-01</small>
    </main>;
  }
}
