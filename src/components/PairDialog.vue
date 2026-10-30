<script setup>
import { ref } from 'vue'

// 配对/设置弹窗：首次打开输 6 位配对码连接；已配对时可解除配对
// 信令地址固定内置，不在此配置
const props = defineProps({
  existing: Object, // 已有配置 {code, androidPeerId} 或 null
})
const emit = defineEmits(['paired', 'unpair', 'close'])

const code = ref(props.existing?.code || '')
const codeError = ref('')

function connect() {
  const c = code.value.trim()
  if (!/^\d{6}$/.test(c)) {
    codeError.value = '请输入 6 位数字配对码'
    return
  }
  // 只有配对码没变时才保留已记住的手机 peerId（重连场景）；
  // 换了码就是配对新手机/重装后的手机（peerId 已变），留着旧 id
  // 会让 sync.js 过滤掉新手机的 join/here，永远不发 offer，卡在"连接中"
  const keepPeerId = props.existing?.code === c ? props.existing?.androidPeerId : null
  emit('paired', {
    code: c,
    androidPeerId: keepPeerId || null,
  })
}
</script>

<template>
  <div class="mask">
    <div class="dialog">
      <h3>连接手机日历</h3>
      <div class="row">
        <label>配对码</label>
        <input
          v-model="code"
          type="text"
          inputmode="numeric"
          maxlength="6"
          placeholder="6 位数字"
          class="code-input"
        />
      </div>
      <div class="err" v-if="codeError">{{ codeError }}</div>
      <div class="tip">
        在手机 Etar「网页同步」里点「生成配对码」，把 6 位数字填到这里。
        配对成功后会记住手机，下次打开自动重连。
      </div>
      <div class="actions">
        <button v-if="existing" class="btn danger" @click="emit('unpair')">解除配对</button>
        <div style="flex: 1"></div>
        <button v-if="existing" class="btn" @click="emit('close')">取消</button>
        <button class="btn primary" @click="connect">连接</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.code-input {
  letter-spacing: 8px;
  font-size: 36px !important;
}

.err {
  color: var(--danger);
  font-size: 26px;
  margin-left: 144px;
}

.tip {
  font-size: 24px;
  color: var(--text-secondary);
  line-height: 1.6;
  margin-top: 8px;
}

.actions {
  display: flex;
  gap: 16px;
}
</style>
