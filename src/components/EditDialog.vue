<script setup>
import { ref, computed } from 'vue'

// 简单编辑弹窗：改标题 / 开始时间 / 优先级 / 宽度（分钟或补满），对应 update 协议
const props = defineProps({
  event: { type: Object, required: true },
})
const emit = defineEmits(['save', 'close', 'delete'])

const title = ref(props.event.title)
const priority = ref(props.event.priority === 1 ? 1 : 0)
const flexible = ref(!!props.event.flexible)
const colSpan = ref(props.event.colSpan || 1)
const delConfirm = ref(false) // 删除两步确认：第一次点变"确认删除?"，再点才删

const MINUTE_OPTIONS = [2, 5, 10, 15, 20, 25]

function selectMinutes(m) {
  flexible.value = false
  colSpan.value = Math.round(m / 2.5)
}

// 开始时间：显示为当天的 HH:mm，保存时按分钟偏移换算回 epoch
const startText = computed(() => {
  const d = new Date(props.event.start)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
})

const startInput = ref(startText.value)

function currentMinutes() {
  return Math.round(colSpan.value * 2.5)
}

function save() {
  const t = title.value.trim()
  if (t.length <= 1) return
  const payload = { title: t, priority: priority.value }
  if (flexible.value) {
    payload.flexible = true
  } else {
    payload.flexible = false
    payload.colSpan = colSpan.value
  }
  // 改了开始时间则平移 start/end（保持原时长跨度）
  const [h, m] = startInput.value.split(':').map(Number)
  if (!Number.isNaN(h) && !Number.isNaN(m)) {
    const old = new Date(props.event.start)
    const base = new Date(old.getFullYear(), old.getMonth(), old.getDate(), h, m, 0, 0)
    const delta = base.getTime() - props.event.start
    if (delta !== 0) {
      payload.start = props.event.start + delta
      payload.end = props.event.end + delta
    }
  }
  emit('save', payload)
}

function onDelete() {
  if (!delConfirm.value) {
    delConfirm.value = true
    return
  }
  emit('delete')
}
</script>

<template>
  <div class="mask" @click.self="$emit('close')">
    <div class="dialog">
      <h3>编辑任务</h3>
      <div class="row">
        <label>内容</label>
        <input v-model="title" type="text" @keydown.enter="save" />
      </div>
      <div class="row">
        <label>开始</label>
        <input v-model="startInput" type="time" step="60" />
      </div>
      <div class="row">
        <label>优先级</label>
        <div class="seg">
          <button class="seg-btn" :class="{ on: priority === 0 }" @click="priority = 0">中</button>
          <button class="seg-btn" :class="{ on: priority === 1 }" @click="priority = 1">高</button>
        </div>
      </div>
      <div class="row" v-if="!event.allDay">
        <label>宽度</label>
        <div class="seg">
          <button
            v-for="m in MINUTE_OPTIONS"
            :key="m"
            class="seg-btn"
            :class="{ on: !flexible && colSpan === Math.round(m / 2.5) }"
            @click="selectMinutes(m)"
          >
            {{ m }}
          </button>
          <button class="seg-btn" :class="{ on: flexible }" @click="flexible = true">补满</button>
        </div>
      </div>
      <div class="hint" v-if="!flexible">当前宽度 {{ currentMinutes() }} 分钟</div>
      <div class="actions">
        <button class="btn danger" :class="{ confirm: delConfirm }" @click="onDelete">
          {{ delConfirm ? '确认删除?' : '删除' }}
        </button>
        <button class="btn" @click="$emit('close')">取消</button>
        <button class="btn primary" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.seg {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  flex: 1;
}

.seg-btn {
  border: 1px solid var(--color-primary);
  border-radius: 4px;
  color: var(--color-primary);
  font-size: 13px;
  padding: 5px 9px;
  background: #fff;
}

.seg-btn.on {
  background: var(--color-primary);
  color: #fff;
}

.hint {
  font-size: 12px;
  color: var(--text-secondary);
  margin-left: 72px;
}

.btn.danger {
  margin-right: auto; /* 删除按钮放最左，与保存/取消分开 */
}

.btn.danger.confirm {
  background: var(--danger);
  color: #fff;
}
</style>
