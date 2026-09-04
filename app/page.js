"use client";

import { useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
  LineChart, Line, Legend, PieChart, Pie, Cell
} from 'recharts';
import {
  Activity, DollarSign, Cpu, Calendar, AlertCircle, TerminalSquare, RefreshCw,
  FolderOpen, MessageSquare, BarChart3, ChevronRight, ArrowUpDown, AlignLeft, ArrowLeft, X, Globe
} from 'lucide-react';
import { i18n } from './i18n';
import './globals.css';

const COLORS = ['#6366f1', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];

// 统一日期格式化：紧凑的 MM/DD HH:mm，拆分成两行显示以节约宽度
const fmtDate = (dateStr) => {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return (
    <div style={{ lineHeight: '1.2' }}>
      <div>{`${mm}/${dd}`}</div>
      <div style={{ fontSize: '0.75rem', color: 'var(--gray-500)', marginTop: '2px' }}>{`${hh}:${mi}`}</div>
    </div>
  );
};

// 仅日期（用于 Project Start Date 等场景）
const fmtDateOnly = (dateStr) => {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const ExpandablePrompt = ({ prompt, t }) => {
  const [expanded, setExpanded] = useState(false);
  if (!prompt) return null;
  const isLong = prompt.length > 80;
  
  return (
    <div style={{ fontSize: '0.85rem', color: 'var(--gray-700)' }}>
      <div style={{
        whiteSpace: expanded ? 'pre-wrap' : 'normal',
        wordBreak: 'break-word',
        display: expanded ? 'block' : '-webkit-box',
        WebkitLineClamp: expanded ? 'unset' : 3,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden'
      }}>
        {prompt}
      </div>
      {isLong && (
        <button 
          onClick={() => setExpanded(!expanded)} 
          style={{ 
            background: 'none', border: 'none', color: 'var(--indigo-600)', 
            fontSize: '0.75rem', cursor: 'pointer', padding: '4px 0', marginTop: '4px',
            textDecoration: 'underline'
          }}>
          {expanded ? t.showLess : t.readMore}
        </button>
      )}
    </div>
  );
};
export default function Dashboard() {
  const [lang, setLang] = useState('en');
  const t = i18n[lang];

  useEffect(() => {
    const saved = localStorage.getItem('ccusage-lang');
    if (saved && (saved === 'en' || saved === 'zh')) {
      setLang(saved);
    }
  }, []);

  const toggleLang = () => {
    const newLang = lang === 'en' ? 'zh' : 'en';
    setLang(newLang);
    localStorage.setItem('ccusage-lang', newLang);
  };

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  
  const [activeTab, setActiveTab] = useState('daily');
  
  // Drill-down states
  const [selectedProject, setSelectedProject] = useState(null);
  const [selectedSession, setSelectedSession] = useState(null);
  const [selectedConversation, setSelectedConversation] = useState(null);
  const [selectedDate, setSelectedDate] = useState(null);

  // Sort state
  const [sortConfig, setSortConfig] = useState({ key: 'date', direction: 'desc' });

  async function fetchData(forceRefresh = false) {
    if (forceRefresh) setRefreshing(true);
    try {
      const url = forceRefresh ? '/api/usage?refresh=true' : '/api/usage';
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to fetch data');
      const json = await res.json();
      
      if (json.error) throw new Error(json.error);

      // Processing Daily data
      let totalCost = 0;
      let totalTokens = 0;
      const dailyChartData = (json.daily || []).map(item => {
        totalCost += item.totalCost || 0;
        totalTokens += item.totalTokens || 0;
        return {
          date: item.period,
          conversationCount: item.conversationCount || 0,
          cost: Number((item.totalCost || 0).toFixed(4)),
          inputTokens: item.inputTokens || 0,
          outputTokens: item.outputTokens || 0,
          cacheTokens: item.cacheTokens || 0,
          totalTokens: item.totalTokens || 0,
          models: item.modelsUsed ? item.modelsUsed.join(', ') : 'Unknown'
        };
      });

      setData({
        daily: dailyChartData,
        projects: json.projects || [],
        sessions: json.sessions || [],
        conversations: json.conversations || [],
        turns: json.turns || [],
        generatedAt: json.generatedAt,
        summary: {
          totalCost: Number(totalCost.toFixed(2)),
          totalTokens,
          days: dailyChartData.length
        }
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    fetchData();
  }, []);

  const handleRefresh = () => fetchData(true);

  const requestSort = (key) => {
    let direction = 'desc';
    if (sortConfig.key === key && sortConfig.direction === 'desc') direction = 'asc';
    setSortConfig({ key, direction });
  };

  const getSortedData = (list) => {
    if (!list) return [];
    return [...list].sort((a, b) => {
      let aVal = a[sortConfig.key];
      let bVal = b[sortConfig.key];
      
      if (sortConfig.key === 'date') {
        aVal = new Date(a.date || a.timestamp).getTime();
        bVal = new Date(b.date || b.timestamp).getTime();
      }
      if (sortConfig.key === 'cost') {
        aVal = a.cost || a.totalCost || 0;
        bVal = b.cost || b.totalCost || 0;
      }
      
      if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
  };

  const SortIcon = () => <ArrowUpDown size={14} style={{display: 'inline', marginLeft: 4, cursor: 'pointer', color: 'var(--gray-400)'}} />;

  if (loading && !data) {
    return (
      <div className="center-container">
        <div className="spinner"></div>
        <p style={{marginTop: '16px', color: 'var(--gray-500)'}}>{t.loading}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="center-container">
        <div className="error-card">
          <AlertCircle size={24} />
          <div><h3>{t.errorLoading}</h3><p>{error}</p></div>
        </div>
      </div>
    );
  }

  const renderProjectName = (raw, extracted) => {
    return <div className="font-medium font-semibold text-gray-800" style={{ wordBreak: 'break-all' }} title={raw}>{extracted}</div>;
  };

  const renderDailyTab = () => (
    <>
      <div className="charts-grid">
        <div className="card chart-container">
          <h3 className="section-title"><Activity className="text-indigo" size={20} /> {t.dailyCostTrend}</h3>
          <div className="chart-wrapper">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.daily}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                <XAxis dataKey="date" stroke="#9ca3af" fontSize={12} tickMargin={10} />
                <YAxis stroke="#9ca3af" fontSize={12} tickFormatter={(val) => `$${val}`} />
                <RechartsTooltip contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)' }} formatter={(value) => [`$${value}`, t.cost]} />
                <Line type="monotone" dataKey="cost" stroke="#6366f1" strokeWidth={3} dot={{ r: 4, strokeWidth: 2 }} activeDot={{ r: 6 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="card chart-container">
          <h3 className="section-title"><BarChart3 className="text-blue" size={20} /> {t.tokensUsageBreakdown}</h3>
          <div className="chart-wrapper">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.daily}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                <XAxis dataKey="date" stroke="#9ca3af" fontSize={12} tickMargin={10} />
                <YAxis stroke="#9ca3af" fontSize={12} tickFormatter={(val) => val >= 1000 ? (val / 1000).toFixed(0) + 'k' : val} />
                <RechartsTooltip contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)' }} formatter={(value, name) => [value.toLocaleString(), name]} />
                <Legend iconType="circle" />
                <Bar dataKey="inputTokens" name={t.input} stackId="a" fill="#3b82f6" radius={[0, 0, 4, 4]} />
                <Bar dataKey="outputTokens" name={t.output} stackId="a" fill="#10b981" />
                <Bar dataKey="cacheTokens" name={t.cache} stackId="a" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
      <div className="card">
        <h3 className="section-title">{t.dailyUsageLog}</h3>
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th onClick={() => requestSort('date')}>{t.date} <SortIcon/></th>
                <th>{t.agentsModels}</th>
                <th className="text-right" onClick={() => requestSort('conversationCount')}>{t.conversations} <SortIcon/></th>
                <th className="text-right" onClick={() => requestSort('cost')}>{t.cost} <SortIcon/></th>
                <th className="text-right">{t.costPerConv}</th>
                <th className="text-right" onClick={() => requestSort('inputTokens')}>{t.input} <SortIcon/></th>
                <th className="text-right" onClick={() => requestSort('outputTokens')}>{t.output} <SortIcon/></th>
                <th className="text-right" onClick={() => requestSort('totalTokens')}>{t.totalTokens} <SortIcon/></th>
              </tr>
            </thead>
            <tbody>
              {getSortedData(data.daily).map((row, i) => {
                const costPerConv = row.conversationCount ? (row.cost / row.conversationCount) : 0;
                return (
                <tr key={i} className="hover-lift" style={{cursor: 'pointer'}} onClick={() => { setSelectedDate(row.date); setActiveTab('conversations'); setSortConfig({ key: 'date', direction: 'desc' }); }}>
                  <td className="font-medium">{new Date(row.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                  <td><div className="model-tags-wrapper">{row.models.split(', ').map(m => m !== 'Unknown' ? <span key={m} className="model-tag" title={m}>{m}</span> : <span key={m}>{m}</span>)}</div></td>
                  <td className="text-right">{row.conversationCount || 0}</td>
                  <td className="text-right text-indigo font-semibold">${row.cost.toFixed(4)}</td>
                  <td className="text-right font-medium">${costPerConv.toFixed(4)}</td>
                  <td className="text-right">{row.inputTokens.toLocaleString()}</td>
                  <td className="text-right">{row.outputTokens.toLocaleString()}</td>
                  <td className="text-right font-medium">{row.totalTokens.toLocaleString()}</td>
                </tr>
              )})}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );

  const renderProjectsTab = () => (
    <>
      <div className="charts-grid">
        <div className="card chart-container">
          <h3 className="section-title"><FolderOpen className="text-indigo" size={20} /> {t.projects}</h3>
          <div className="chart-wrapper" style={{display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={data.projects} dataKey="totalCost" nameKey="projectName" cx="50%" cy="50%" outerRadius={100} innerRadius={60} label={({projectName, percent}) => percent > 0.05 ? `${projectName} (${(percent * 100).toFixed(0)}%)` : ''}>
                  {data.projects.map((entry, index) => <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />)}
                </Pie>
                <RechartsTooltip formatter={(value) => [`$${value.toFixed(4)}`, 'Cost']} contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)' }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
      <div className="card">
        <h3 className="section-title">{t.project}</h3>
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{width: '22%'}} onClick={() => requestSort('projectName')}>{t.project} <SortIcon/></th>
                <th style={{width: '90px'}} onClick={() => requestSort('firstActivity')}>{t.date} <SortIcon/></th>
                <th>{t.agentsModels}</th>
                <th style={{width: '90px', textAlign: 'center'}} onClick={() => requestSort('sessionCount')}>{t.sessions} <SortIcon/></th>
                <th style={{width: '80px', textAlign: 'center'}} onClick={() => requestSort('conversationCount')}>{t.convsShort} <SortIcon/></th>
                <th style={{width: '90px'}} className="text-right" onClick={() => requestSort('cost')}>{t.cost} <SortIcon/></th>
                <th style={{width: '80px'}} className="text-right">{t.costPerConv}</th>
                <th style={{width: '100px'}} className="text-right" onClick={() => requestSort('totalTokens')}>{t.totalTokens} <SortIcon/></th>
                <th style={{width: '90px'}} className="text-right">{t.action}</th>
              </tr>
            </thead>
            <tbody>
              {getSortedData(data.projects).map((row, i) => {
                const costPerConv = row.conversationCount ? (row.totalCost / row.conversationCount) : 0;
                return (
                <tr key={i}>
                  <td>{renderProjectName(row.rawProjectName, row.projectName)}</td>
                  <td className="ts-cell text-gray-500 font-medium text-xs">{fmtDateOnly(row.firstActivity)}</td>
                  <td><div className="model-tags-wrapper">{row.models.map(m => <span key={m} className="model-tag" title={m}>{m}</span>)}</div></td>
                  <td className="text-center">{row.sessionCount}</td>
                  <td className="text-center">{row.conversationCount || 0}</td>
                  <td className="text-right text-indigo font-semibold">${row.totalCost.toFixed(4)}</td>
                  <td className="text-right font-medium">${costPerConv.toFixed(4)}</td>
                  <td className="text-right font-medium">{row.totalTokens.toLocaleString()}</td>
                  <td className="text-right">
                    <button className="drill-btn" onClick={() => { setSelectedProject(row.projectName); setActiveTab('sessions'); setSortConfig({ key: 'date', direction: 'desc' }); }}>
                      {t.sessions} <ChevronRight size={13}/>
                    </button>
                  </td>
                </tr>
              );})}
              {data.projects.length === 0 && <tr><td colSpan="9" className="text-center" style={{padding: '24px'}}>{t.noProjects}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );

  const renderSessionsTab = () => {
    let filtered = data.sessions;
    if (selectedProject) filtered = filtered.filter(s => s.projectName === selectedProject);

    return (
      <div className="card">
        <div className="card-header-flex">
          <h3 className="section-title" style={{margin:0}}>
            <MessageSquare className="text-indigo" size={20} />
            {t.sessions}
            {selectedProject && (
              <span className="filter-bubble">
                {t.project}: {selectedProject}
                <X size={14} className="filter-bubble-close" onClick={() => setSelectedProject(null)} />
              </span>
            )}
          </h3>
          {selectedProject && (
            <button className="back-btn" onClick={() => setActiveTab('projects')}><ArrowLeft size={16} /> {t.backToProjects}</button>
          )}
        </div>
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{width: '120px'}} onClick={() => requestSort('date')}>{t.time} <SortIcon/></th>
                {!selectedProject && <th style={{width: '15%'}} onClick={() => requestSort('projectName')}>{t.project} <SortIcon/></th>}
                <th style={{width: '15%'}} onClick={() => requestSort('sessionName')}>{t.session} <SortIcon/></th>
                <th>{t.agentsModels}</th>
                <th style={{width: '100px'}} className="text-right" onClick={() => requestSort('totalTokens')}>{t.totalTokens} <SortIcon/></th>
                <th style={{width: '90px'}} className="text-right" onClick={() => requestSort('cost')}>{t.cost} <SortIcon/></th>
                <th style={{width: '90px'}} className="text-right">{t.action}</th>
              </tr>
            </thead>
            <tbody>
              {getSortedData(filtered).map((row, i) => (
                <tr key={i}>
                  <td className="ts-cell font-medium">{fmtDate(row.date)}</td>
                  {!selectedProject && <td>{renderProjectName(row.rawProjectName, row.projectName)}</td>}
                  <td>
                    <div style={{fontWeight: '500', color: 'var(--gray-800)'}}>{row.sessionName !== row.sessionId ? row.sessionName : 'Unnamed Session'}</div>
                    <div style={{fontSize: '0.75rem', color: 'var(--gray-500)'}}>{row.sessionId.split('-')[0]}...</div>
                  </td>
                  <td><div className="model-tags-wrapper">{row.models.map(m => <span key={m} className="model-tag" title={m}>{m}</span>)}</div></td>
                  <td className="text-right font-medium">{row.totalTokens.toLocaleString()}</td>
                  <td className="text-right text-indigo font-semibold">${row.cost.toFixed(4)}</td>
                  <td className="text-right">
                    <button className="drill-btn" onClick={() => { setSelectedSession(row.sessionId); setActiveTab('conversations'); setSortConfig({ key: 'date', direction: 'desc' }); }}>
                      {t.conversations} <ChevronRight size={13}/>
                    </button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && <tr><td colSpan="7" className="text-center" style={{padding: '24px'}}>{t.noSessions}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderConversationsTab = () => {
    let filtered = data.conversations;
    if (selectedSession) filtered = filtered.filter(c => c.sessionId === selectedSession);
    else if (selectedProject) filtered = filtered.filter(c => c.projectName === selectedProject);
    else if (selectedDate) filtered = filtered.filter(c => c.date && c.date.startsWith(selectedDate));

    return (
      <div className="card">
        <div className="card-header-flex">
          <h3 className="section-title" style={{margin:0}}>
            <AlignLeft className="text-indigo" size={20} />
            {t.conversations}
            {selectedProject && (
              <span className="filter-bubble">
                {t.project}: {selectedProject}
                <X size={14} className="filter-bubble-close" onClick={() => setSelectedProject(null)} />
              </span>
            )}
            {selectedSession && (
              <span className="filter-bubble">
                {t.session}: {selectedSession.substring(0,8)}
                <X size={14} className="filter-bubble-close" onClick={() => setSelectedSession(null)} />
              </span>
            )}
            {selectedDate && (
              <span className="filter-bubble">
                {t.date}: {selectedDate}
                <X size={14} className="filter-bubble-close" onClick={() => setSelectedDate(null)} />
              </span>
            )}
          </h3>
          {selectedSession ? (
            <button className="back-btn" onClick={() => setActiveTab('sessions')}><ArrowLeft size={16} /> {t.backToSessions}</button>
          ) : selectedProject ? (
            <button className="back-btn" onClick={() => setActiveTab('projects')}><ArrowLeft size={16} /> {t.backToProjects}</button>
          ) : selectedDate ? (
            <button className="back-btn" onClick={() => setActiveTab('daily')}><ArrowLeft size={16} /> {t.backToDailyTrends}</button>
          ) : null}
        </div>
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{width: '80px'}} onClick={() => requestSort('date')}>{t.time} <SortIcon/></th>
                <th style={{width: '12%'}} onClick={() => requestSort('projectName')}>{t.project} <SortIcon/></th>
                <th style={{width: '12%'}} onClick={() => requestSort('sessionId')}>{t.session} <SortIcon/></th>
                <th>{t.userPrompt}</th>
                <th style={{width: '50px', textAlign: 'center'}} onClick={() => requestSort('turnCount')}>{t.turns} <SortIcon/></th>
                <th style={{width: '140px'}}>{t.model}</th>
                <th style={{width: '80px'}} className="text-right" onClick={() => requestSort('totalTokens')}>{t.totalTokens} <SortIcon/></th>
        <th style={{width: '75px'}} className="text-right" onClick={() => requestSort('cost')}>{t.cost} <SortIcon/></th>
        <th style={{width: '75px'}} className="text-right">{t.action}</th>
      </tr>
    </thead>
    <tbody>
      {getSortedData(filtered).map((row, i) => (
        <tr key={i}>
          <td className="ts-cell font-medium">{fmtDate(row.date)}</td>
          <td className="text-xs">{renderProjectName(row.rawProjectName, row.projectName)}</td>
          <td className="text-xs">
            <div title={row.sessionName} className="font-medium text-gray-700" style={{wordBreak: 'break-all'}}>{row.sessionName || row.sessionId.substring(0,8)}</div>
            <div className="text-gray-400" style={{fontSize: '10px'}}>{row.sessionId.substring(0,8)}</div>
          </td>
          <td>
            <ExpandablePrompt prompt={row.prompt} t={t} />
          </td>
          <td className="text-center">{row.turnCount}</td>
          <td><div className="model-tags-wrapper">{row.models.map(m => <span key={m} className="model-tag" title={m}>{m}</span>)}</div></td>
          <td className="text-right font-medium">{row.totalTokens.toLocaleString()}</td>
          <td className="text-right text-indigo font-semibold">${row.cost.toFixed(4)}</td>
          <td className="text-right">
            <button className="drill-btn" onClick={() => { setSelectedConversation(row.id); setActiveTab('turns'); setSortConfig({ key: 'date', direction: 'desc' }); }}>
              {t.turns} <ChevronRight size={13}/>
            </button>
          </td>
        </tr>
      ))}
      {filtered.length === 0 && <tr><td colSpan="9" className="text-center" style={{padding: '24px'}}>{t.noConversations}</td></tr>}
    </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderTurnsTab = () => {
    let filtered = data.turns;
    if (selectedConversation) filtered = filtered.filter(t => t.conversationId === selectedConversation);
    else if (selectedSession) filtered = filtered.filter(t => t.sessionId === selectedSession);
    else if (selectedProject) filtered = filtered.filter(t => t.projectName === selectedProject);

    return (
      <div className="card">
        <div className="card-header-flex">
          <h3 className="section-title" style={{margin:0}}>
            <TerminalSquare className="text-indigo" size={20} />
            {t.turns}
            {selectedConversation && (
              <span className="filter-bubble">
                {t.conversation}: {selectedConversation.substring(0,8)}
                <X size={14} className="filter-bubble-close" onClick={() => setSelectedConversation(null)} />
              </span>
            )}
          </h3>
          <button className="back-btn" onClick={() => setActiveTab('conversations')}><ArrowLeft size={16} /> {t.backToConversations}</button>
        </div>
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th onClick={() => requestSort('date')}>{t.time} <SortIcon/></th>
                <th onClick={() => requestSort('model')}>{t.model} <SortIcon/></th>
                <th className="text-right" onClick={() => requestSort('inputTokens')}>{t.input} <SortIcon/></th>
                <th className="text-right" onClick={() => requestSort('outputTokens')}>{t.output} <SortIcon/></th>
                <th className="text-right" onClick={() => requestSort('cacheTokens')}>{t.cache} <SortIcon/></th>
                <th className="text-right" onClick={() => requestSort('totalTokens')}>{t.totalTokens} <SortIcon/></th>
                <th className="text-right" onClick={() => requestSort('cost')}>{t.cost} <SortIcon/></th>
              </tr>
            </thead>
            <tbody>
              {getSortedData(filtered).map((row, i) => (
                <tr key={i}>
                  <td className="ts-cell font-medium">{fmtDate(row.timestamp)}</td>
                  <td><span className="model-tag">{row.model}</span></td>
                  <td className="text-right">{row.inputTokens.toLocaleString()}</td>
                  <td className="text-right text-green-600">{row.outputTokens.toLocaleString()}</td>
                  <td className="text-right text-purple-600">{row.cacheTokens.toLocaleString()}</td>
                  <td className="text-right font-medium">{row.totalTokens.toLocaleString()}</td>
                  <td className="text-right text-indigo font-semibold">${row.cost.toFixed(5)}</td>
                </tr>
              ))}
              {filtered.length === 0 && <tr><td colSpan="7" className="text-center" style={{padding: '24px'}}>{t.noTurns}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <div>
          <h1 className="header-title"><TerminalSquare className="icon-primary" size={32} /> {t.title}</h1>
          <p className="header-subtitle">
            {t.subtitle}
            {data.generatedAt && <span style={{marginLeft: '12px', fontSize: '0.8rem', color: 'var(--gray-400)'}}>{t.lastUpdated} {new Date(data.generatedAt).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')}</span>}
          </p>
        </div>
        <div style={{display: 'flex', gap: '12px', alignItems: 'center'}}>
          <button onClick={toggleLang} className="refresh-btn" style={{background: 'var(--gray-100)', color: 'var(--gray-700)', borderColor: 'var(--gray-300)'}}>
            <Globe size={18} /> {lang === 'en' ? '中文' : 'EN'}
          </button>
          <button onClick={handleRefresh} className={`refresh-btn ${refreshing ? 'refreshing' : ''}`} disabled={refreshing}>
            <RefreshCw size={18} className={refreshing ? 'spin-icon' : ''} /> {refreshing ? t.syncing : t.refresh}
          </button>
        </div>
      </header>

      <div className="summary-grid">
        <div className="card stat-card hover-lift">
          <div className="stat-icon icon-bg-indigo text-indigo"><DollarSign size={24} /></div>
          <div><p className="stat-title">{t.totalCost}</p><h2 className="stat-value">${data.summary.totalCost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</h2></div>
        </div>
        <div className="card stat-card hover-lift">
          <div className="stat-icon icon-bg-blue text-blue"><Cpu size={24} /></div>
          <div><p className="stat-title">{t.totalTokens}</p><h2 className="stat-value">{data.summary.totalTokens.toLocaleString()}</h2></div>
        </div>
        <div className="card stat-card hover-lift">
          <div className="stat-icon icon-bg-green text-green"><Calendar size={24} /></div>
          <div><p className="stat-title">{t.activeDays}</p><h2 className="stat-value">{data.summary.days}</h2></div>
        </div>
        <div className="card stat-card hover-lift">
          <div className="stat-icon icon-bg-indigo text-indigo"><FolderOpen size={24} /></div>
          <div><p className="stat-title">{t.projects}</p><h2 className="stat-value">{data.projects.length}</h2></div>
        </div>
        <div className="card stat-card hover-lift">
          <div className="stat-icon icon-bg-blue text-blue"><MessageSquare size={24} /></div>
          <div><p className="stat-title">{t.sessions}</p><h2 className="stat-value">{data.sessions.length}</h2></div>
        </div>
        <div className="card stat-card hover-lift">
          <div className="stat-icon icon-bg-green text-green"><AlignLeft size={24} /></div>
          <div><p className="stat-title">{t.conversations}</p><h2 className="stat-value">{data.conversations.length}</h2></div>
        </div>
      </div>

      <div className="tabs-container">
        <button className={`tab-btn ${activeTab === 'daily' ? 'active' : ''}`} onClick={() => setActiveTab('daily')}>
          <Activity size={18} /> {t.dailyTrends}
        </button>
        <button className={`tab-btn ${activeTab === 'projects' ? 'active' : ''}`} onClick={() => setActiveTab('projects')}>
          <FolderOpen size={18} /> {t.projects}
        </button>
        <button className={`tab-btn ${activeTab === 'sessions' ? 'active' : ''}`} onClick={() => setActiveTab('sessions')}>
          <MessageSquare size={18} /> {t.sessions}
        </button>
        <button className={`tab-btn ${activeTab === 'conversations' ? 'active' : ''}`} onClick={() => setActiveTab('conversations')}>
          <AlignLeft size={18} /> {t.conversations}
        </button>
        {activeTab === 'turns' && (
          <button className="tab-btn active">
            <TerminalSquare size={18} /> {t.turns}
          </button>
        )}
      </div>

      {activeTab === 'daily' && renderDailyTab()}
      {activeTab === 'projects' && renderProjectsTab()}
      {activeTab === 'sessions' && renderSessionsTab()}
      {activeTab === 'conversations' && renderConversationsTab()}
      {activeTab === 'turns' && renderTurnsTab()}
    </div>
  );
}
