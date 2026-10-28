<script setup>
import { ref, computed, watch } from 'vue'

// 底部创建栏：复刻安卓 CreateDayEventDialogFragment 的输入框样式
// 行1：优先级切换 + 输入框 + 确定；行2：2/5/10/15/20/25/补满
const props = defineProps({
  slotMinute: Number, // 目标时段（当天分钟偏移 0/30）
  defaultFlexible: Boolean, // 目标时段为空（第一个任务）时默认选中「补满」
})
const emit = defineEmits(['create'])

const title = ref('')
const highPriority = ref(false)
const minutes = ref(2)
const flexible = ref(false)
const inputEl = ref(null)

const MINUTE_OPTIONS = [2, 5, 10, 15, 20, 25]

// 打开弹窗/切换时段时按"第一个任务"规则刷新默认选中项（用户手动改过后以新的时段重新判定）
watch(
  () => [props.slotMinute, props.defaultFlexible],
  () => {
    flexible.value = props.defaultFlexible
    if (!props.defaultFlexible) minutes.value = 2
  },
  { immediate: true }
)

const slotText = computed(() => {
  const h = String(Math.floor(props.slotMinute / 60)).padStart(2, '0')
  const m = String(props.slotMinute % 60).padStart(2, '0')
  const end = props.slotMinute + 29
  const eh = String(Math.floor(end / 60)).padStart(2, '0')
  const em = String(end % 60).padStart(2, '0')
  return `${h}:${m} - ${eh}:${em}`
})

function selectMinutes(m) {
  flexible.value = false
  minutes.value = m
}

function submit() {
  const t = title.value.trim()
  if (t.length <= 1) return
  emit('create', {
    title: t,
    priority: highPriority.value ? 1 : 0,
    flexible: flexible.value,
    minutes: minutes.value,
  })
  title.value = ''
  if (inputEl.value) inputEl.value.focus()
}
</script>

<template>
  <div class="create-bar">
    <div class="input-row">
      <button
        class="priority-toggle"
        :class="{ high: highPriority }"
        @click="highPriority = !highPriority"
      >
        {{ highPriority ? '高' : '中' }}
      </button>
      <input
        ref="inputEl"
        v-model="title"
        class="content-input"
        :placeholder="`任务内容（${slotText}）`"
        @keydown.enter="submit"
      />
      <button class="save-btn" title="确定" @click="submit">&#10003;</button>
    </div>
    <div class="minute-row">
      <button
        v-for="m in MINUTE_OPTIONS"
        :key="m"
        class="minute-btn"
        :class="{ checked: !flexible && minutes === m }"
        @click="selectMinutes(m)"
      >
        {{ m }}
      </button>
      <button class="minute-btn" :class="{ checked: flexible }" @click="flexible = true">
        补满
      </button>
    </div>
  </div>
</template>

<style scoped>
.create-bar {
  flex-shrink: 0;
  background: #fff;
  border-top: 1px solid #ddd;
  padding: 8px 8px calc(8px + env(safe-area-inset-bottom));
  z-index: 10;
}

.input-row {
  display: flex;
  align-items: stretch;
}

/* 优先级按钮：左上角圆角，复刻 bg_priority_medium / bg_priority_high */
.priority-toggle {
  color: #fff;
  font-size: 16px;
  min-width: 44px;
  padding: 0 6px;
  background: var(--color-primary);
  border-radius: 8px 0 0 0;
}

.priority-toggle.high {
  background: var(--high-priority);
}

.content-input {
  flex: 1;
  border: 1px solid #ccc;
  border-left: none;
  border-right: none;
  padding: 12px;
  font-size: 16px;
  outline: none;
  min-width: 0;
}

.save-btn {
  color: var(--color-primary);
  font-size: 20px;
  padding: 0 12px;
  background: var(--color-primary);
  color: #fff;
  border-radius: 0 8px 0 0;
}

.save-btn:hover {
  background: #303f9f;
}

.minute-row {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  flex-wrap: wrap;
}

/* 时长按钮：复刻 bg_minute_option，选中实心、未选描边 */
.minute-btn {
  flex: 1;
  min-width: 38px;
  padding: 6px 0;
  border: 1px solid var(--color-primary);
  border-radius: 4px;
  color: var(--color-primary);
  font-size: 14px;
  background: #fff;
}

.minute-btn.checked {
  background: var(--color-primary);
  color: #fff;
}
</style>
