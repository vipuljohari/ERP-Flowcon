
import React, { useRef, useEffect } from 'react';
import { Part, Sale } from '../types';

interface ReportGeneratorProps {
  parts: Part[];
  sales: Sale[];
  activeCustomer: string;
  onImageGenerated: (blob: Blob) => void;
  trigger: boolean;
  reportDate?: Date;
}

const getCustomerSchedule = (p: Part, customerName: string) => {
  if (!p.schedules) return 0;
  const key = Object.keys(p.schedules).find(k => k.toUpperCase().trim() === customerName.toUpperCase().trim());
  return key ? p.schedules[key] || 0 : 0;
};

const getCustomerRate = (p: Part, customerName: string) => {
  if (!p.customerRates) return p.rate || 0;
  const key = Object.keys(p.customerRates).find(k => k.toUpperCase().trim() === customerName.toUpperCase().trim());
  return key ? p.customerRates[key] ?? p.rate : p.rate;
};

const normalizeCustomerName = (s: string) => (s || '').toUpperCase().trim();

// The original Share Achievement card (16-item list, top-8/bottom-8 HT/NML
// boxes) was custom-built for exactly these 2 customers and must keep its
// exact existing logic/appearance untouched. Every other customer gets the
// generic card built below (their own Item Master list, SAP code instead of
// Part Name, no HT/NML boxes).
const LEGACY_ACHIEVEMENT_CUSTOMERS = [
  'SIAC-SKH INDIA CABS Mfg. Pvt. Ltd. Palwal',
  'SIAC-SKH INDIA CABS MFG Pvt. Ltd. Jaipur',
].map(normalizeCustomerName);

const isLegacyAchievementCustomer = (customerName: string) =>
  LEGACY_ACHIEVEMENT_CUSTOMERS.includes(normalizeCustomerName(customerName));

const ReportGenerator: React.FC<ReportGeneratorProps> = ({ parts, sales, activeCustomer, onImageGenerated, trigger, reportDate }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const generateReport = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Use passed reportDate or fallback to now
    const selectedDate = reportDate || new Date();
    const now = new Date();
    
    // Check if selectedDate is in a past month or current month
    const isCurrentMonth = selectedDate.getMonth() === now.getMonth() && selectedDate.getFullYear() === now.getFullYear();

    // Wait for fonts to be ready
    try {
      await document.fonts.ready;
    } catch (e) {
      console.warn("Font loading wait failed, proceeding anyway");
    }

    // Polyfill for roundRect
    if (!ctx.roundRect) {
      ctx.roundRect = function (x: number, y: number, w: number, h: number, r: number | number[]) {
        if (typeof r === 'number') r = [r, r, r, r];
        this.beginPath();
        this.moveTo(x + r[0], y);
        this.lineTo(x + w - r[1], y);
        this.quadraticCurveTo(x + w, y, x + w, y + r[1]);
        this.lineTo(x + w, y + h - r[2]);
        this.quadraticCurveTo(x + w, y + h, x + w - r[2], y + h);
        this.lineTo(x + r[3], y + h);
        this.quadraticCurveTo(x, y + h, x, y + h - r[3]);
        this.lineTo(x, y + r[0]);
        this.quadraticCurveTo(x, y, x + r[0], y);
        this.closePath();
        return this;
      };
    }

    // Set high-res dimensions
    canvas.width = 1080;
    canvas.height = 1920;

    // Adherence threshold calculation
    // If it's a past month, threshold is 100% (since it's a closed audit).
    // If it's the current month, calculate proportional today.
    const dayOfSelected = selectedDate.getDate();
    const lastDayOfSelected = new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1, 0).getDate();
    const adherenceThreshold = isCurrentMonth ? (dayOfSelected / lastDayOfSelected) * 100 : 100;

    // 1. Background
    const grad = ctx.createLinearGradient(0, 0, 0, 1920);
    grad.addColorStop(0, '#0f172a');
    grad.addColorStop(1, '#1e1b4b');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1080, 1920);

    // 2. Header Section
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.roundRect(0, 0, 1080, 420, [0, 0, 100, 100]);
    ctx.fill();

    ctx.fillStyle = '#6366f1'; 
    ctx.font = '900 40px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('FLOWCON AUTO • IMT FARIDABAD', 80, 110);

    const monthYearLong = selectedDate.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 85px Inter, system-ui, sans-serif';
    ctx.fillText(`Summary ${monthYearLong}`, 80, 200);

    const todayLabel = selectedDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
    ctx.fillStyle = '#94a3b8';
    ctx.font = '700 35px Inter, system-ui, sans-serif';
    ctx.fillText(todayLabel + ' • DISPATCH BREAKUP', 80, 260);

    ctx.fillStyle = '#fbbf24'; 
    ctx.font = '900 40px Inter, system-ui, sans-serif';
    ctx.fillText(activeCustomer.toUpperCase(), 80, 350);

    // 3. Robust Calculation Metrics
    const filteredSales = sales.filter(s => s.customer && activeCustomer && s.customer.toUpperCase().trim() === activeCustomer.toUpperCase().trim());
    
    // Global Totals (Quantity based for items, but Percentage is now Value-based per user request)
    const totalTarget = parts.reduce((acc, p) => acc + getCustomerSchedule(p, activeCustomer), 0) || 1;
    const totalDispatch = filteredSales.reduce((acc, s) => acc + s.quantity, 0);

    // Monetary Totals (Value based) - This now drives the TTL ACH %
    const totalSalesValue = filteredSales.reduce((acc, s) => acc + s.totalPrice, 0);
    const totalScheduledValue = parts.reduce((acc, p) => {
      const target = getCustomerSchedule(p, activeCustomer);
      const rate = getCustomerRate(p, activeCustomer);
      return acc + (target * rate);
    }, 0) || 1;

    const totalAchv = (totalSalesValue / totalScheduledValue) * 100;
    const valueAchvDisplay = `${(totalSalesValue / 100000).toFixed(2)} L / ${(totalScheduledValue / 100000).toFixed(2)} L`;

    // This custom card (16-item list, HT/NML top-8/bottom-8 boxes) is
    // preserved exactly as-is for SIAC Palwal/Jaipur. Every other customer
    // gets the generic card (own Item Master list, SAP code, TTL ACH only).
    const isLegacyCard = isLegacyAchievementCustomer(activeCustomer);

    // HT (Top 8 Items) — legacy card only
    const htPartsList = parts.slice(0, 8);
    const htTarget = htPartsList.reduce((acc, p) => acc + getCustomerSchedule(p, activeCustomer), 0) || 1;
    const htDispatch = filteredSales.filter(s => htPartsList.some(p => p.id === s.partId)).reduce((acc, s) => acc + s.quantity, 0);
    const htAchvPercent = (htDispatch / htTarget) * 100;

    // Nml (Last 8 Items) — legacy card only
    const nmlPartsList = parts.slice(8, 16);
    const nmlTarget = nmlPartsList.reduce((acc, p) => acc + getCustomerSchedule(p, activeCustomer), 0) || 1;
    const nmlDispatch = filteredSales.filter(s => nmlPartsList.some(p => p.id === s.partId)).reduce((acc, s) => acc + s.quantity, 0);
    const nmlAchvPercent = (nmlDispatch / nmlTarget) * 100;

    // --- RENDER TOP METRICS ---
    ctx.textAlign = 'center';

    if (isLegacyCard) {
      // HT ACH Box (Left)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.roundRect(80, 500, 240, 160, 30);
      ctx.fill();
      ctx.fillStyle = htAchvPercent >= adherenceThreshold ? '#10b981' : '#ef4444';
      ctx.font = '900 50px Inter, system-ui, sans-serif';
      ctx.fillText(`${htAchvPercent.toFixed(1)}%`, 200, 580);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '800 24px Inter, system-ui, sans-serif';
      ctx.fillText('HT ACH', 200, 625);
    }

    // Main Circle (Center)
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.arc(540, 580, 150, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = totalAchv >= adherenceThreshold ? '#10b981' : '#ef4444';
    ctx.lineWidth = 18;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(540, 580, 150, -Math.PI / 2, (-Math.PI / 2) + (Math.PI * 2 * (Math.min(totalAchv, 100) / 100)));
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = '900 90px Inter, system-ui, sans-serif';
    ctx.fillText(`${totalAchv.toFixed(1)}%`, 540, 585);
    
    // Label: TTL ACH
    ctx.font = '800 28px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('TTL ACH', 540, 630);

    // Value Fraction: 5.13 L / 10.20 L
    ctx.font = '900 22px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(valueAchvDisplay, 540, 675);

    if (isLegacyCard) {
      // Nml ACH Box (Right)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.roundRect(760, 500, 240, 160, 30);
      ctx.fill();
      ctx.fillStyle = nmlAchvPercent >= adherenceThreshold ? '#10b981' : '#ef4444';
      ctx.font = '900 50px Inter, system-ui, sans-serif';
      ctx.fillText(`${nmlAchvPercent.toFixed(1)}%`, 880, 580);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '800 24px Inter, system-ui, sans-serif';
      ctx.fillText('NML ACH', 880, 625);
    }

    // --- RENDER PARTS LIST ---
    ctx.textAlign = 'left';
    const listStartY = 760;
    const listEndY = 1800;
    const barX = 580;
    const barWidth = 300;

    if (isLegacyCard) {
      // Unchanged: fixed 16-item list, top-to-bottom in Item Master order.
      let y = listStartY;
      const rowHeight = 65;
      const barHeight = 40;

      parts.slice(0, 16).forEach((p, index) => {
        const pTarget = getCustomerSchedule(p, activeCustomer);
        const pDispatch = filteredSales.filter(s => s.partId === p.id).reduce((sum, s) => sum + s.quantity, 0);
        const pAchv = (pDispatch / (pTarget || 1)) * 100;

        ctx.beginPath();

        ctx.fillStyle = '#ffffff';
        ctx.font = '800 26px Inter, system-ui, sans-serif';
        const nameStr = `${index + 1}. ${p.name}`;
        ctx.fillText(nameStr.length > 28 ? nameStr.substring(0, 28) + '...' : nameStr, 80, y);

        ctx.fillStyle = '#94a3b8';
        ctx.font = '700 20px Inter, system-ui, sans-serif';
        ctx.fillText(`DISPATCH: ${pDispatch} / ${pTarget}`, 80, y + 32);

        const barY = y - 12;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
        ctx.roundRect(barX, barY, barWidth, barHeight, 12);
        ctx.fill();

        const isAdherent = pAchv >= adherenceThreshold;
        const fillColor = isAdherent ? '#10b981' : '#ef4444';

        const fillWidth = Math.min((pAchv / 100) * barWidth, barWidth);
        if (fillWidth > 0) {
          ctx.beginPath();
          ctx.fillStyle = fillColor;
          const visibleFillWidth = (pAchv > 0 && fillWidth < 12) ? 12 : fillWidth;
          ctx.roundRect(barX, barY, visibleFillWidth, barHeight, 12);
          ctx.fill();
        }

        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.font = '900 25px Inter, system-ui, sans-serif';
        ctx.fillText(`${pAchv.toFixed(0)}%`, barX + barWidth + 60, barY + 28);

        ctx.textAlign = 'left';
        y += rowHeight;
      });
    } else {
      // Generic card: this customer's own Item Master list (any count),
      // SAP code shown instead of Part Name. Same per-row bar/% styling as
      // the legacy card, with row height/font size scaled to fit however
      // many items this customer actually has.
      const customerParts = parts.filter(p =>
        p.mappedCustomers?.some(c => normalizeCustomerName(c) === normalizeCustomerName(activeCustomer))
      );

      if (customerParts.length > 0) {
        const availableHeight = listEndY - listStartY;
        const rowHeight = Math.max(30, Math.min(65, availableHeight / customerParts.length));
        const scale = rowHeight / 65;
        const barHeight = 40 * scale;

        let y = listStartY;
        customerParts.forEach((p, index) => {
          const pTarget = getCustomerSchedule(p, activeCustomer);
          const pDispatch = filteredSales.filter(s => s.partId === p.id).reduce((sum, s) => sum + s.quantity, 0);
          const pAchv = (pDispatch / (pTarget || 1)) * 100;

          ctx.beginPath();

          ctx.fillStyle = '#ffffff';
          ctx.font = `800 ${Math.round(26 * scale)}px Inter, system-ui, sans-serif`;
          const codeStr = `${index + 1}. ${p.sapCode || p.name}`;
          ctx.fillText(codeStr.length > 28 ? codeStr.substring(0, 28) + '...' : codeStr, 80, y);

          ctx.fillStyle = '#94a3b8';
          ctx.font = `700 ${Math.round(20 * scale)}px Inter, system-ui, sans-serif`;
          ctx.fillText(`DISPATCH: ${pDispatch} / ${pTarget}`, 80, y + 32 * scale);

          const barY = y - 12 * scale;
          ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
          ctx.roundRect(barX, barY, barWidth, barHeight, 12);
          ctx.fill();

          const isAdherent = pAchv >= adherenceThreshold;
          const fillColor = isAdherent ? '#10b981' : '#ef4444';

          const fillWidth = Math.min((pAchv / 100) * barWidth, barWidth);
          if (fillWidth > 0) {
            ctx.beginPath();
            ctx.fillStyle = fillColor;
            const visibleFillWidth = (pAchv > 0 && fillWidth < 12) ? 12 : fillWidth;
            ctx.roundRect(barX, barY, visibleFillWidth, barHeight, 12);
            ctx.fill();
          }

          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'center';
          ctx.font = `900 ${Math.round(25 * scale)}px Inter, system-ui, sans-serif`;
          ctx.fillText(`${pAchv.toFixed(0)}%`, barX + barWidth + 60, barY + 28 * scale);

          ctx.textAlign = 'left';
          y += rowHeight;
        });
      }
    }

    // 5. Footer Section
    ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.fillRect(0, 1820, 1080, 100);
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'center';
    ctx.font = '700 24px Inter, system-ui, sans-serif';
    ctx.fillText('GENERATED BY FLOWCON AUTO INTELLIGENCE ENGINE', 540, 1885);

    // Final Image Generation
    setTimeout(() => {
      canvas.toBlob((blob) => {
        if (blob) onImageGenerated(blob);
      }, 'image/jpeg', 0.95);
    }, 150);
  };

  useEffect(() => {
    if (trigger) {
      generateReport();
    }
  }, [trigger, activeCustomer]);

  return <canvas ref={canvasRef} style={{ display: 'none' }} />;
};

export default ReportGenerator;
