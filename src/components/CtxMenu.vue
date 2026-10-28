<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'

// 右键菜单：移植手机端长按菜单（编辑/移动/弹性/优先级/调整时长/补满/删除）
const props = defineProps({
  menu: { type: Object, required: true }, // {event, x, y}
})
const emit = defineEmits(['action', 'adjust', 'close'])

const MENU_MINUTES = [2, 5, 10, 15, 20, 25]
const showDuration = ref(false)
const el = ref(null)
const pos = ref({ left: props.menu.x, top: props.menu.y })

const event = computed(() => props.menu.event)

const items = computed(() => {
  const e = event.value
  const list = [{ action: 'edit', label: '编辑' }]
  if (e.allDay) {
    // 与手机端一致：今天的全天任务显示"移动到明天"，更早的显示"移动到今天"
    const isToday = new Date(e.start).toDateString() === new Date().toDateString()
    list.push(isToday ? { action: 'move-tomorrow', label: '移动到明天' } : { action: 'move-today', label: '移动到今天' })
  }
  if (!e.allDay) {
    list.push({ action: 'toggle-flexible', label: e.flexible ? '取消弹性任务' : '设为弹性任务' })
  }
  list.push({ action: 'toggle-priority', label: e.priority === 1 ? '取消高优先级' : '设为高优先级' })
  if (!e.allDay && !e.flexible) {
    list.push({ action: 'adjust', label: '调整时长' })
    list.push({ action: 'fill', label: '补满' })
  }
  list.push({ action: 'delete', label: '删除', danger: true })
  return list
})

function onItemClick(item) {
  if (item.action === 'adjust') {
    showDuration.value = !showDuration.value
    return
  }
  emit('action', { action: item.action, event: event.value })
}

// 防止菜单超出视口
onMounted(() => {
  requestAnimationFrame(() => {
    const rect = el.value.getBoundingClientRect()
    pos.value = {
      left: Math.min(props.menu.x, window.innerWidth - rect.width - 8),
      top: Math.min(props.menu.y, window.innerHeight - rect.height - 8),
    }
  })
  window.addEventListener('click', closeOnOutside, true)
  window.addEventListener('contextmenu', closeOnOutside, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('click', closeOnOutside, true)
  window.removeEventListener('contextmenu', closeOnOutside, true)
})

function closeOnOutside(ev) {
  if (el.value && !el.value.contains(ev.target)) emit('close')
}
</script>

<template>
  <div ref="el" class="ctx-menu" :style="{ left: pos.left + 'px', top: pos.top + 'px' }">
    <template v-for="item in items" :key="item.action">
      <button class="item" :class="{ danger: item.danger }" @click="onItemClick(item)">
        {{ item.label }}
        <span v-if="item.action === 'adjust'" class="arrow">&#9656;</span>
      </button>
      <div v-if="item.action === 'adjust' && showDuration" class="sub">
        <button
          v-for="m in MENU_MINUTES"
          :key="m"
          class="item"
          @click="emit('adjust', event, m)"
        >
          {{ m }}分钟
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ctx-menu {
  position: fixed;
  z-index: 200;
  background: #fff;
  border-radius: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  padding: 6px 0;
  min-width: 150px;
}

.item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 9px 18px;
  font-size: 14px;
  color: var(--text-primary);
}

.item:hover {
  background: rgba(0, 0, 0, 0.06);
}

.item.danger {
  color: var(--danger);
}

.sub {
  border-left: 2px solid var(--color-primary);
  margin-left: 18px;
}

.arrow {
  float: right;
  color: var(--text-secondary);
}
</style>
