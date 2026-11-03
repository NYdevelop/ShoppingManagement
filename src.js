(() => {
    'use strict';

    /* =========================================================
     * Constants
     * ======================================================= */
    const STORAGE_KEY = 'stock_app_items';
    const MAX_STOCK_ICONS = 10;
    const URGENT_DAYS = 3;

    // 消費ペースの学習設定
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const LEARNING_RATE = 0.3;     // 新しい実測値をどれだけ反映するか（0〜1）
    const MIN_ELAPSED_DAYS = 0.5;  // 経過がこれ未満の操作（誤タップ等）は学習に使わない

    const createDefaultItems = () => [
        { id: '1', name: 'トイレットペーパー', stock: 2, alert: 3, daysPerUnit: 5,  pendingBuy: 0, lastRestockedAt: null, consumedSincePurchase: 0 },
        { id: '2', name: 'ボックスティッシュ', stock: 5, alert: 2, daysPerUnit: 10, pendingBuy: 0, lastRestockedAt: null, consumedSincePurchase: 0 },
        { id: '3', name: '食器用洗剤',         stock: 1, alert: 2, daysPerUnit: 14, pendingBuy: 0, lastRestockedAt: null, consumedSincePurchase: 0 },
        { id: '4', name: 'シャンプー詰め替え', stock: 0, alert: 1, daysPerUnit: 20, pendingBuy: 0, lastRestockedAt: null, consumedSincePurchase: 0 },
    ];

    const TAB_CLASSES = {
        active:   ['font-bold', 'border-emerald-600', 'text-emerald-600'],
        inactive: ['font-semibold', 'border-transparent', 'text-slate-500', 'hover:text-slate-700'],
    };

    /* =========================================================
     * State
     * ======================================================= */
    const state = {
        items: [],
        activeTab: 'shopping',
        isSortMode: false,
        isThreeColumns: true,
    };

    let sortable = null;
    let currentShareUrl = '';

    /* =========================================================
     * Utilities
     * ======================================================= */
    const $ = (id) => document.getElementById(id);
    const show = (el) => el.classList.remove('hidden');
    const hide = (el) => el.classList.add('hidden');

    const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

    const createId = () =>
        (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random().toString(16).slice(2, 6)}`);

    const toInt = (value, fallback, min) => {
        const n = Number.parseInt(value, 10);
        return Number.isFinite(n) ? Math.max(min, n) : fallback;
    };

    const findItem = (id) => state.items.find((item) => item.id === id);
    const isLowStock = (item) => item.stock <= item.alert;
    const daysRemaining = (item) => item.stock * item.daysPerUnit;

    /* =========================================================
     * Data model / persistence
     * ======================================================= */

    /** 外部入力（localStorage / URL）を安全な形に正規化する。不正なら null。 */
    function normalizeItem(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const name = String(raw.name ?? '').trim();
        if (!name) return null;
        return {
            id: String(raw.id ?? createId()),
            name,
            stock: toInt(raw.stock, 0, 0),
            alert: toInt(raw.alert, 1, 1),
            daysPerUnit: toInt(raw.daysPerUnit, 1, 1),
            pendingBuy: toInt(raw.pendingBuy, 0, 0),
            lastRestockedAt: toInt(raw.lastRestockedAt, null, 1),
            consumedSincePurchase: toInt(raw.consumedSincePurchase, 0, 0),
        };
    }

    function normalizeItems(list) {
        return Array.isArray(list) ? list.map(normalizeItem).filter(Boolean) : null;
    }

    function loadItems() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            const items = saved ? normalizeItems(JSON.parse(saved)) : null;
            if (items) return items;
        } catch (e) {
            console.warn('Failed to load saved items:', e);
        }
        return createDefaultItems();
    }

    function saveItems() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state.items));
        } catch (e) {
            console.warn('Failed to save items:', e);
        }
    }

    /* =========================================================
     * URL sharing
     * ======================================================= */
    function buildShareUrl() {
        const payload = state.items.map((item) => ({ ...item, pendingBuy: 0 }));
        const encoded = btoa(encodeURIComponent(JSON.stringify(payload)));
        return `${location.origin}${location.pathname}#${encoded}`;
    }

    /** URLハッシュからデータを復元する。無い/壊れている場合は null。 */
    function restoreItemsFromHash() {
        const encoded = location.hash.slice(1);
        if (!encoded) return null;
        try {
            const items = normalizeItems(JSON.parse(decodeURIComponent(atob(encoded))));
            if (items) {
                history.replaceState(null, '', location.pathname + location.search);
                return items;
            }
        } catch (e) {
            console.warn('Failed to restore from URL:', e);
        }
        return null;
    }

    /* =========================================================
     * Templates
     * ======================================================= */
    function stockIconsHtml(item) {
        if (item.stock === 0) {
            return '<span class="text-xs font-bold text-rose-500">在庫切れ</span>';
        }
        const tone = isLowStock(item)
            ? 'text-amber-500 fill-amber-100'
            : 'text-emerald-600 fill-emerald-100';
        const icons = `<i data-lucide="package" class="w-4 h-4 ${tone}"></i>`
            .repeat(Math.min(item.stock, MAX_STOCK_ICONS));
        const overflow = item.stock > MAX_STOCK_ICONS
            ? `<span class="text-xs font-bold text-slate-500 ml-1">+${item.stock - MAX_STOCK_ICONS}</span>`
            : '';
        return icons + overflow;
    }

    function shoppingCardHtml(item) {
        const low = isLowStock(item);
        const hasPending = item.pendingBuy > 0;
        const { isSortMode } = state;

        const tone = low
            ? 'bg-amber-100 border-amber-300 text-amber-900'
            : 'bg-slate-100 border-slate-200 text-slate-700';
        const mode = isSortMode
            ? 'cursor-grab active:cursor-grabbing border-dashed border-slate-400'
            : 'active:scale-95';

        const grip = isSortMode
            ? '<i data-lucide="grip-vertical" class="text-slate-400 w-4 h-4 flex-shrink-0"></i>'
            : '';
        const minusButton = !isSortMode && hasPending
            ? `<button type="button" data-action="decrease-pending" title="減らす"
                       class="w-7 bg-white/90 hover:bg-white text-slate-700 font-bold rounded-full border border-slate-300 flex items-center justify-center text-sm shadow-sm">-</button>`
            : '';
        const pendingBadge = hasPending
            ? `<div class="bg-emerald-500 text-white font-bold text-[11px] px-2 py-0.5 rounded-full shadow-sm">+${item.pendingBuy}</div>`
            : '';

        return `
            <div data-id="${escapeHtml(item.id)}"
                 class="item-card relative p-3.5 rounded-2xl border-2 flex flex-col justify-between h-36 transition-all ${tone} ${mode}">
                <div class="flex items-start justify-between">
                    <span class="font-bold text-wrap text-sm sm:text-base leading-tight truncate pr-1">${escapeHtml(item.name)}</span>
                    ${grip}
                </div>
                <div class="flex items-center justify-between my-1">
                    <div class="text-xs font-semibold ${low ? 'text-amber-700' : 'text-slate-500'}">
                        在庫: <span class="text-sm font-bold">${item.stock}</span>
                    </div>
                </div>
                <span class="text-[10px] text-slate-500">閾値: ${item.alert}</span>
                <div class="flex items-end justify-between mt-auto">
                    ${pendingBadge}
                    ${minusButton}
                </div>
            </div>`;
    }

    function manageCardHtml(item) {
        const low = isLowStock(item);
        const days = daysRemaining(item);
        const stepButtonClass =
            'w-7 h-7 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-lg flex items-center justify-center';

        return `
            <div data-id="${escapeHtml(item.id)}" class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-3">
                <div class="flex items-center justify-between border-b pb-2">
                    <div>
                        <h4 class="font-bold text-slate-800 text-sm">${escapeHtml(item.name)}</h4>
                        <p class="text-xs text-slate-500">消費目安: ${item.daysPerUnit}日に1個</p>
                    </div>
                    <div class="flex items-center gap-1">
                        <button type="button" data-action="edit" aria-label="編集"
                                class="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100">
                            <i data-lucide="edit-3" class="w-4 h-4"></i>
                        </button>
                        <button type="button" data-action="delete" aria-label="削除"
                                class="p-1.5 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-slate-100">
                            <i data-lucide="trash-2" class="w-4 h-4"></i>
                        </button>
                    </div>
                </div>

                <div class="space-y-1">
                    <div class="flex items-center justify-between text-xs">
                        <span class="font-bold text-slate-600">現在のストック残量:</span>
                        <span class="font-bold ${low ? 'text-amber-600' : 'text-slate-700'}">${item.stock} 個 (アラート基準: ${item.alert}個以下)</span>
                    </div>
                    <div class="flex items-center gap-1 py-1 flex-wrap">${stockIconsHtml(item)}</div>
                </div>

                <div class="bg-slate-50 p-2.5 rounded-lg flex items-center justify-between text-xs">
                    <span class="text-slate-600 flex items-center gap-1">
                        <i data-lucide="clock" class="w-3.5 h-3.5 text-slate-400"></i> 在庫切れ予測:
                    </span>
                    <span class="font-bold ${days <= URGENT_DAYS ? 'text-rose-600' : 'text-slate-700'}">
                        ${days === 0 ? '今すぐ購入が必要です' : `あと 約 ${days} 日分`}
                    </span>
                </div>

                <div class="flex items-center justify-end gap-2 pt-1">
                    <span class="text-xs text-slate-500">クイック変更:</span>
                    <button type="button" data-action="stock-down" aria-label="在庫を1減らす" class="${stepButtonClass}">-</button>
                    <button type="button" data-action="stock-up" aria-label="在庫を1増やす" class="${stepButtonClass}">+</button>
                </div>
            </div>`;
    }

    /* =========================================================
     * Rendering
     * ======================================================= */
    function renderTabs() {
        document.querySelectorAll('[data-tab]').forEach((btn) => {
            const isActive = btn.dataset.tab === state.activeTab;
            btn.classList.add(...(isActive ? TAB_CLASSES.active : TAB_CLASSES.inactive));
            btn.classList.remove(...(isActive ? TAB_CLASSES.inactive : TAB_CLASSES.active));
        });
        $('viewShopping').classList.toggle('hidden', state.activeTab !== 'shopping');
        $('viewManage').classList.toggle('hidden', state.activeTab !== 'manage');
    }

    function renderShoppingView() {
        $('itemGrid').className =
            `grid ${state.isThreeColumns ? 'grid-cols-3' : 'grid-cols-2'} gap-3 transition-all`;
        $('itemGrid').innerHTML = state.items.map(shoppingCardHtml).join('');
        $('colBtnText').textContent = state.isThreeColumns ? '2列表示' : '3列表示';
        $('sortBtnText').textContent = state.isSortMode ? '完了' : '並び替え';
        sortable?.option('disabled', !state.isSortMode);
    }

    function renderManageView() {
        $('manageList').innerHTML = state.items.map(manageCardHtml).join('');
    }

    function renderCartBar() {
        const selected = state.items.filter((item) => item.pendingBuy > 0);
        $('cartSummary').textContent = selected.length
            ? selected.map((item) => `${item.name} (+${item.pendingBuy})`).join(', ')
            : 'なし';
        $('cartBar').classList.toggle('translate-y-full', selected.length === 0);
    }

    function render() {
        renderTabs();
        renderShoppingView();
        renderManageView();
        renderCartBar();
        lucide.createIcons();
    }

    /** 状態を変更したあとの共通処理：保存 → 再描画 */
    function commit() {
        saveItems();
        render();
    }

    /* =========================================================
     * Actions
     * ======================================================= */
    function changePendingBuy(id, delta) {
        const item = findItem(id);
        if (!item) return;
        item.pendingBuy = Math.max(0, item.pendingBuy + delta);
        commit();
    }

    /**
     * 実測から「1個あたりの消費日数」を推定する（指数移動平均）。
     * 実測値 = 前回購入からの経過日数 ÷ それまでに消費した個数
     */
    function estimateDaysPerUnit(currentDays, elapsedMs, consumedCount) {
        const elapsedDays = elapsedMs / MS_PER_DAY;
        if (consumedCount <= 0 || elapsedDays < MIN_ELAPSED_DAYS) return currentDays;

        const observed = elapsedDays / consumedCount;
        const blended = currentDays * (1 - LEARNING_RATE) + observed * LEARNING_RATE;
        return Math.max(1, Math.round(blended));
    }

    /** 1個消費したことを記録し、消費ペースを更新する。 */
    function recordConsumption(item, now = Date.now()) {
        // 購入履歴がない（既存データ等）場合は、この操作を起点にして次回から学習する
        if (!item.lastRestockedAt) {
            item.lastRestockedAt = now;
            item.consumedSincePurchase = 0;
            return;
        }
        item.consumedSincePurchase += 1;
        item.daysPerUnit = estimateDaysPerUnit(
            item.daysPerUnit,
            now - item.lastRestockedAt,
            item.consumedSincePurchase,
        );
    }

    function commitPurchase() {
        const now = Date.now();
        state.items.forEach((item) => {
            if (item.pendingBuy <= 0) return;
            item.stock += item.pendingBuy;
            item.pendingBuy = 0;
            item.lastRestockedAt = now;     // 次回の消費ペース計算の起点
            item.consumedSincePurchase = 0;
        });
        commit();
    }

    function adjustStock(id, delta) {
        const item = findItem(id);
        if (!item) return;

        const hadStock = item.stock > 0;
        item.stock = Math.max(0, item.stock + delta);
        if (delta < 0 && hadStock) recordConsumption(item);
        commit();
    }

    function deleteItem(id) {
        if (!confirm('このアイテムを削除してもよろしいですか？')) return;
        state.items = state.items.filter((item) => item.id !== id);
        commit();
    }

    function reorderItems({ oldIndex, newIndex }) {
        if (oldIndex === newIndex) return;
        const [moved] = state.items.splice(oldIndex, 1);
        state.items.splice(newIndex, 0, moved);
        saveItems();
    }

    /* =========================================================
     * Modals
     * ======================================================= */
    const openModal = (id) => show($(id));
    const closeModal = (id) => hide($(id));

    function openEditModal(item = null) {
        $('modalTitle').textContent = item ? 'アイテムの編集' : '新しいアイテムの追加';
        $('editItemId').value = item?.id ?? '';
        $('inputName').value = item?.name ?? '';
        $('inputStock').value = item?.stock ?? 1;
        $('inputAlert').value = item?.alert ?? 1;
        $('inputDaysPerUnit').value = item?.daysPerUnit ?? 7;
        openModal('editModal');
    }

    function readEditForm() {
        return {
            name: $('inputName').value.trim(),
            stock: toInt($('inputStock').value, 0, 0),
            alert: toInt($('inputAlert').value, 1, 1),
            daysPerUnit: toInt($('inputDaysPerUnit').value, 1, 1),
        };
    }

    function submitEditForm(event) {
        event.preventDefault();
        const data = readEditForm();
        if (!data.name) return;

        const id = $('editItemId').value;
        if (id) {
            const item = findItem(id);
            if (item) Object.assign(item, data);
        } else {
            state.items.push({
                id: createId(),
                pendingBuy: 0,
                lastRestockedAt: Date.now(),
                consumedSincePurchase: 0,
                ...data,
            });
        }

        commit();
        closeModal('editModal');
    }

    function openShareModal() {
        currentShareUrl = buildShareUrl();

        const qr = $('qrcode');
        qr.innerHTML = '';
        try {
            new QRCode(qr, {
                text: currentShareUrl,
                width: 160,
                height: 160,
                correctLevel: QRCode.CorrectLevel.L, // 長いURLでも入るよう誤り訂正を最小に
            });
        } catch (e) {
            console.warn('QR generation failed:', e);
            qr.innerHTML =
                '<p class="text-xs text-slate-500 text-center">データが大きすぎてQRコードを作れません。<br>URLコピーをご利用ください。</p>';
        }

        hide($('copyNotice'));
        openModal('shareModal');
    }

    async function copyShareUrl() {
        try {
            await navigator.clipboard.writeText(currentShareUrl);
            show($('copyNotice'));
        } catch (e) {
            console.warn('Clipboard write failed:', e);
            window.prompt('URLをコピーしてください', currentShareUrl);
        }
    }

    /* =========================================================
     * Event binding
     * ======================================================= */
    function bindTabs() {
        document.querySelectorAll('[data-tab]').forEach((btn) => {
            btn.addEventListener('click', () => {
                state.activeTab = btn.dataset.tab;
                renderTabs();
            });
        });
    }

    function bindShoppingView() {
        $('toggleColumnsBtn').addEventListener('click', () => {
            state.isThreeColumns = !state.isThreeColumns;
            render();
        });

        $('toggleSortBtn').addEventListener('click', () => {
            state.isSortMode = !state.isSortMode;
            render();
        });

        $('itemGrid').addEventListener('click', (event) => {
            const card = event.target.closest('[data-id]');
            if (!card || state.isSortMode) return;

            const delta = event.target.closest('[data-action="decrease-pending"]') ? -1 : 1;
            changePendingBuy(card.dataset.id, delta);
        });

        $('commitPurchaseBtn').addEventListener('click', commitPurchase);
    }

    function bindManageView() {
        const actions = {
            'edit':       (id) => openEditModal(findItem(id)),
            'delete':     (id) => deleteItem(id),
            'stock-down': (id) => adjustStock(id, -1),
            'stock-up':   (id) => adjustStock(id, 1),
        };

        $('manageList').addEventListener('click', (event) => {
            const button = event.target.closest('[data-action]');
            const card = button?.closest('[data-id]');
            if (card) actions[button.dataset.action]?.(card.dataset.id);
        });

        $('addNewItemBtn').addEventListener('click', () => openEditModal());
    }

    function bindModals() {
        $('shareBtn').addEventListener('click', openShareModal);
        $('closeShareModal').addEventListener('click', () => closeModal('shareModal'));
        $('copyUrlBtn').addEventListener('click', copyShareUrl);

        $('closeEditModal').addEventListener('click', () => closeModal('editModal'));
        $('itemForm').addEventListener('submit', submitEditForm);

        // 背景クリック / Esc で閉じる
        ['shareModal', 'editModal'].forEach((id) => {
            $(id).addEventListener('click', (event) => {
                if (event.target === event.currentTarget) closeModal(id);
            });
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') ['shareModal', 'editModal'].forEach(closeModal);
        });

        $('restoredBannerClose').addEventListener('click', () => hide($('restoredBanner')));
    }

    function initSortable() {
        sortable = new Sortable($('itemGrid'), {
            animation: 150,
            disabled: true, // 並び替えモード中のみ有効化
            onEnd: reorderItems,
        });
    }

    /* =========================================================
     * Bootstrap
     * ======================================================= */
    function init() {
        const restored = restoreItemsFromHash();
        if (restored) {
            state.items = restored;
            saveItems();
            show($('restoredBanner'));
        } else {
            state.items = loadItems();
        }

        bindTabs();
        bindShoppingView();
        bindManageView();
        bindModals();
        initSortable();
        render();
    }

    document.addEventListener('DOMContentLoaded', init);
})();
