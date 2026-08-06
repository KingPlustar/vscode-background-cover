<template>
    <div class="advanced-tab">
        <!-- Auto random -->
        <el-card class="card" shadow="never">
            <template #header>
                <span class="card-title">
                    <el-icon><Refresh /></el-icon>
                    {{ t('autoRandom') }}
                </span>
            </template>

            <div class="row">
                <span class="row-label">{{ t('enabled') }}</span>
                <el-switch
                    :model-value="!!config.autoStatus"
                    @change="(v: any) => bridge.post({ type: 'setConfig', key: 'autoStatus', value: v })"
                />
            </div>

            <div v-if="config.playMode === 'random'" class="row">
                <span class="row-label">{{ t('antiSticky') }}</span>
                <el-switch
                    :model-value="!!config.antiSticky"
                    @change="(v: any) => bridge.post({ type: 'setConfig', key: 'antiSticky', value: v })"
                />
            </div>
            <div v-if="config.playMode === 'random'" class="anti-sticky-hint">{{ t('antiStickyHint') }}</div>

            <div v-if="config.playMode === 'random' && config.antiSticky" class="row">
                <span class="row-label">{{ t('antiStickyLevel') }}</span>
                <div class="level-group">
                    <el-slider
                        :model-value="Number(config.antiStickyLevel ?? 2)"
                        :min="1"
                        :max="10"
                        :step="1"
                        class="level-slider"
                        @change="(v: any) => bridge.post({ type: 'setConfig', key: 'antiStickyLevel', value: v })"
                    />
                    <span class="level-value">{{ Number(config.antiStickyLevel ?? 2) }}</span>
                </div>
            </div>
            <div v-if="config.playMode === 'random' && config.antiSticky" class="anti-sticky-hint">{{ t('antiStickyLevelHint') }}</div>

            <div class="row">
                <span class="row-label">{{ t('playOrder') }}</span>
                <el-select
                    :model-value="config.playMode"
                    size="small"
                    class="inline-select"
                    @change="(v: any) => bridge.post({ type: 'setConfig', key: 'playMode', value: v })"
                >
                    <el-option :label="t('playRandom')" value="random" />
                    <el-option :label="t('playSequence')" value="sequence" />
                </el-select>
            </div>

            <div class="row">
                <span class="row-label">{{ t('triggerMode') }}</span>
                <el-select
                    :model-value="config.triggerMode"
                    size="small"
                    class="inline-select"
                    @change="(v: any) => bridge.post({ type: 'setConfig', key: 'triggerMode', value: v })"
                >
                    <el-option :label="t('triggerTimer')" value="timer" />
                    <el-option :label="t('triggerStartup')" value="startup" />
                </el-select>
            </div>

            <div v-if="config.triggerMode === 'timer'" class="row">
                <span class="row-label">{{ t('intervalSeconds') }}</span>
                <div class="interval-group">
                    <el-input-number
                        :model-value="Number(config.autoInterval ?? 10)"
                        :min="config.autoIntervalUnit === 'days' ? 1 : 3"
                        :max="config.autoIntervalUnit === 'days' ? 365 : 3600"
                        :step="1"
                        size="small"
                        controls-position="right"
                        class="interval-input"
                        @change="onIntervalChange"
                    />
                    <el-select
                        :model-value="config.autoIntervalUnit"
                        size="small"
                        class="unit-select"
                        @change="(v: any) => bridge.post({ type: 'setConfig', key: 'autoIntervalUnit', value: v })"
                    >
                        <el-option :label="t('seconds')" value="seconds" />
                        <el-option :label="t('days')" value="days" />
                    </el-select>
                </div>
            </div>

            <div class="row">
                <span class="row-label">{{ t('sourceFolder') }}</span>
                <el-button link type="primary" class="folder-btn" :title="config.randomImageFolder" @click="onSourceFolder">
                    <span class="folder-text">{{ shortFolder || t('notSet') }}</span>
                    <el-icon><ArrowRight /></el-icon>
                </el-button>
            </div>
        </el-card>

        <!-- Per-image rotation settings -->
        <el-card v-if="config.randomImageFolder" class="card" shadow="never">
            <template #header>
                <span class="card-title">
                    <el-icon><Picture /></el-icon>
                    {{ t('imageConfigs') }}
                    <el-tag v-if="state.imageConfigs.length" size="small" round>{{ state.imageConfigs.length }}</el-tag>
                </span>
            </template>

            <el-empty
                v-if="state.imageConfigs.length === 0"
                :description="t('imageConfigsEmpty')"
                :image-size="56"
            />
            <div v-else class="image-config-list">
                <div v-for="item in state.imageConfigs" :key="item.name" class="image-config-item">
                    <div class="image-config-info">
                        <span class="image-config-name" :title="item.name">{{ item.name }}</span>
                        <span class="image-config-meta">
                            {{ t('weight') }}: {{ item.weight }}
                            · {{ t('dwellBonus') }}: {{ item.dwellBonusSeconds }}s
                            · {{ t('minDisplay') }}: {{ item.minDisplaySeconds }}s
                        </span>
                    </div>
                    <div class="image-config-actions">
                        <el-button link type="primary" size="small" @click="openEdit(item)">
                            <el-icon><Edit /></el-icon>
                            {{ t('imageConfigEdit') }}
                        </el-button>
                        <el-button link type="danger" size="small" @click="removeConfig(item)">
                            <el-icon><Delete /></el-icon>
                            {{ t('imageConfigDelete') }}
                        </el-button>
                    </div>
                </div>
            </div>

            <el-button class="block-btn add-config-btn" @click="addConfig">
                <el-icon><Plus /></el-icon>
                {{ t('imageConfigAdd') }}
            </el-button>
        </el-card>

        <!-- Config dialog -->
        <el-dialog
            v-model="dialogVisible"
            :title="t('configImageTitle')"
            width="88%"
            append-to-body
        >
            <el-form label-position="top" size="small">
                <div class="dialog-file">{{ editingName }}</div>
                <el-form-item :label="t('weight')">
                    <el-input-number v-model="form.weight" :min="0" :max="10000" :step="1" controls-position="right" class="dialog-input" />
                    <div class="field-hint">{{ t('weightHint') }}</div>
                </el-form-item>
                <el-form-item :label="t('dwellBonus')">
                    <el-input-number v-model="form.dwellBonusSeconds" :min="-86400" :max="86400" :step="1" controls-position="right" class="dialog-input" />
                    <div class="field-hint">{{ t('dwellBonusHint') }}</div>
                </el-form-item>
                <el-form-item :label="t('minDisplay')">
                    <el-input-number v-model="form.minDisplaySeconds" :min="0" :max="86400" :step="1" controls-position="right" class="dialog-input" />
                    <div class="field-hint">{{ t('minDisplayHint') }}</div>
                </el-form-item>
            </el-form>
            <template #footer>
                <el-button size="small" @click="dialogVisible = false">{{ t('imageConfigCancel') }}</el-button>
                <el-button size="small" type="primary" @click="saveConfig">{{ t('imageConfigSave') }}</el-button>
            </template>
        </el-dialog>

        <!-- Size mode -->
        <el-card class="card" shadow="never">
            <template #header>
                <span class="card-title">
                    <el-icon><FullScreen /></el-icon>
                    {{ t('sizeMode') }}
                </span>
            </template>
            <el-select
                :model-value="config.sizeModel"
                size="small"
                class="block-select"
                @change="(v: any) => bridge.post({ type: 'setConfig', key: 'sizeModel', value: v })"
            >
                <el-option v-for="opt in SIZE_MODES" :key="opt" :label="opt" :value="opt" />
            </el-select>
        </el-card>

        <!-- Blend mode -->
        <el-card class="card" shadow="never">
            <template #header>
                <span class="card-title">
                    <el-icon><Brush /></el-icon>
                    {{ t('blendMode') }}
                </span>
            </template>
            <el-select
                :model-value="config.blendModel"
                size="small"
                class="block-select"
                @change="(v: any) => bridge.post({ type: 'setConfig', key: 'blendModel', value: v })"
            >
                <el-option v-for="opt in BLEND_MODES" :key="opt" :label="opt" :value="opt" />
            </el-select>
        </el-card>

        <!-- Misc -->
        <el-card class="card" shadow="never">
            <div class="quick-actions">
                <el-button class="block-btn" @click="onOpenCache">
                    <el-icon><FolderOpened /></el-icon>
                    {{ t('openCacheFolder') }}
                </el-button>
                <el-button class="block-btn" type="danger" plain @click="onSupport">
                    <el-icon><Star /></el-icon>
                    {{ t('supportAuthor') }}
                </el-button>
            </div>
        </el-card>
    </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { Refresh, ArrowRight, FullScreen, Brush, FolderOpened, Star, Plus, Edit, Delete, Picture } from '@element-plus/icons-vue';
import { ElMessageBox } from 'element-plus';
import { useI18n } from '../composables/useI18n';
import { useBridge } from '../composables/useBridge';
import { config, state } from '../composables/useStore';
import { ActionType, SIZE_MODES, BLEND_MODES } from '../constants';

const { t } = useI18n();
const bridge = useBridge();

const shortFolder = computed(() => {
    const p = config.randomImageFolder || '';
    if (!p) { return ''; }
    return p.length > 26 ? '…' + p.slice(-25) : p;
});

let intervalTimer: number | undefined;

function onIntervalChange(v: number | undefined) {
    const value = Number(v ?? 10);
    if (intervalTimer) { clearTimeout(intervalTimer); }
    intervalTimer = window.setTimeout(() => {
        bridge.post({ type: 'setConfig', key: 'autoInterval', value });
    }, 300);
}
function onSourceFolder() { bridge.post({ type: 'runAction', action: ActionType.AddDirectory }); }
function onOpenCache()    { bridge.post({ type: 'runAction', action: ActionType.OpenCacheFolder }); }
function onSupport()      { bridge.post({ type: 'runAction', action: ActionType.OpenFilePath, path: '//resources//support.jpg' }); }

// --- Per-image rotation settings ---
const dialogVisible = ref(false);
const editingName = ref('');
const form = reactive({ weight: 10, dwellBonusSeconds: 0, minDisplaySeconds: 0 });

function addConfig() {
    bridge.post({ type: 'pickImageForConfig' });
}

bridge.on('imageConfigPick', (data: any) => {
    const name = data?.name;
    if (!name) { return; }
    const existing = state.imageConfigs.find(i => i.name === name);
    editingName.value = name;
    form.weight = existing?.weight ?? 10;
    form.dwellBonusSeconds = existing?.dwellBonusSeconds ?? 0;
    form.minDisplaySeconds = existing?.minDisplaySeconds ?? 0;
    dialogVisible.value = true;
});

function openEdit(item: { name: string; weight: number; dwellBonusSeconds: number; minDisplaySeconds: number }) {
    editingName.value = item.name;
    form.weight = item.weight;
    form.dwellBonusSeconds = item.dwellBonusSeconds;
    form.minDisplaySeconds = item.minDisplaySeconds;
    dialogVisible.value = true;
}

function saveConfig() {
    bridge.post({
        type: 'saveImageConfig',
        name: editingName.value,
        weight: form.weight,
        dwellBonusSeconds: form.dwellBonusSeconds,
        minDisplaySeconds: form.minDisplaySeconds
    });
    dialogVisible.value = false;
}

function removeConfig(item: { name: string }) {
    ElMessageBox.confirm(t('configDeleteConfirm'), t('imageConfigDelete'), {
        confirmButtonText: t('imageConfigDelete'),
        cancelButtonText: t('imageConfigCancel'),
        type: 'warning'
    }).then(() => {
        bridge.post({ type: 'removeImageConfig', name: item.name });
    }).catch(() => { /* cancelled */ });
}
</script>

<style lang="scss" scoped>
.advanced-tab { display: flex; flex-direction: column; gap: 12px; }

.card :deep(.el-card__header) { padding: 8px 12px; }
.card :deep(.el-card__body)   { padding: 10px 12px; }

.card-title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-foreground);
    .el-icon { color: var(--studio-accent); }
}

.row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 0;
    & + .row { border-top: var(--studio-divider); }
}

.row-label {
    font-size: 12px;
    color: var(--vscode-foreground);
}

.folder-btn {
    max-width: 70%;
    overflow: hidden;
    .folder-text {
        max-width: 140px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        direction: rtl;
    }
}

.block-select { width: 100%; }

.interval-input { width: 120px; }

.quick-actions {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
}

.block-btn.block-btn {
    width: 100% !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    text-align: center;
    margin: 0 !important;
}

.block-btn :deep(> span) {
    width: 100%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
}

.inline-select { width: 150px; }

.interval-group {
    display: flex;
    align-items: center;
    gap: 6px;
}

.unit-select { width: 92px; }

.image-config-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 260px;
    overflow-y: auto;
    margin-bottom: 10px;
}

.image-config-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 8px;
    border: 1px solid rgba(120, 140, 200, 0.18);
    border-radius: 6px;
    background: var(--studio-input-bg);
}

.image-config-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}

.image-config-name {
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.image-config-meta {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.image-config-actions {
    display: flex;
    flex-shrink: 0;
    gap: 2px;
}

.add-config-btn { margin-top: 4px; }

.dialog-file {
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-foreground);
    margin-bottom: 8px;
    word-break: break-all;
}

.field-hint {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    line-height: 1.4;
    margin-top: 2px;
}

.dialog-input { width: 100%; }

.anti-sticky-hint {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    line-height: 1.4;
    padding: 0 0 6px;
}

.level-group {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 55%;
}

.level-slider { flex: 1; }

.level-value {
    font-size: 12px;
    min-width: 18px;
    text-align: right;
    color: var(--vscode-foreground);
}
</style>
