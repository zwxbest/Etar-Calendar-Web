<script setup>
defineProps({
  dateText: String,
  status: String,
  statusClass: String,
})
defineEmits(['prev', 'next', 'settings'])
</script>

<template>
  <header class="top-bar">
    <button class="nav-btn" title="昨天" @click="$emit('prev')">&#8249;</button>
    <div class="date">{{ dateText }}</div>
    <button class="nav-btn" title="明天" @click="$emit('next')">&#8250;</button>
    <div class="spacer"></div>
    <span class="status" :class="statusClass">{{ status }}</span>
    <button class="settings-btn" title="设置" @click="$emit('settings')">&#9881;</button>
  </header>
</template>

<style scoped>
.top-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 24px;
  background: var(--color-primary);
  color: #fff;
  flex-shrink: 0;
  z-index: 10;
}

.nav-btn {
  color: #fff;
  font-size: 52px;
  line-height: 1;
  width: 72px;
  height: 72px;
  border-radius: 50%;
  flex-shrink: 0;
}

.nav-btn:hover {
  background: rgba(255, 255, 255, 0.15);
}

.date {
  font-size: 32px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.spacer {
  flex: 1;
}

.status {
  font-size: 24px;
  padding: 6px 20px;
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.2);
  white-space: nowrap;
}

.status.connected {
  background: #2e7d32;
}

.status.connecting,
.status.offline {
  background: #ef6c00;
}

.settings-btn {
  color: #fff;
  font-size: 40px;
  width: 64px;
  height: 64px;
  border-radius: 50%;
  margin-left: 12px;
  flex-shrink: 0;
}

.settings-btn:hover {
  background: rgba(255, 255, 255, 0.15);
}
</style>
