<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="robots" content="noindex,nofollow">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>لوحة التحكم - Admin</title>
<style>
  body {
    margin: 0;
    font-family: -apple-system, "Segoe UI", Tahoma, Arial, sans-serif;
    background: #101314;
    color: #e8e6e1;
    padding: 20px;
  }
  .container { max-width: 600px; margin: 0 auto; }
  h1 { font-size: 20px; }
  input {
    background: #171b1d;
    border: 1px solid #262b2e;
    color: #e8e6e1;
    border-radius: 8px;
    padding: 11px 12px;
    font-size: 14px;
    width: 100%;
    margin-bottom: 10px;
    box-sizing: border-box;
  }
  button {
    background: #5ec8b8;
    color: #08211d;
    border: none;
    border-radius: 8px;
    padding: 12px 20px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    width: 100%;
    margin-bottom: 8px;
  }
  button.danger { background: #e07a7a; }
  .msg { font-size: 13px; margin: 10px 0; min-height: 16px; }
  table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 13px; }
  th, td { text-align: right; padding: 8px; border-bottom: 1px solid #262b2e; }
  .premium-yes { color: #5ec8b8; }
  .premium-no { color: #8a9296; }
</style>
</head>
<body>
<div class="container">
  <h1>لوحة تحكم Admin</h1>

  <input type="password" id="adminSecret" placeholder="كلمة السر ديال Admin">
  <input type="email" id="targetEmail" placeholder="إيميل المستخدم">
  <button id="activateBtn">فعّل كـ مشترك (Premium)</button>
  <button id="deactivateBtn" class="danger">ألغي التفعيل</button>
  <button id="loadUsersBtn">شوف كل المستخدمين</button>
  <div class="msg" id="msg"></div>

  <table id="usersTable" style="display:none">
    <thead><tr><th>الإيميل</th><th>الحالة</th><th>تاريخ التسجيل</th></tr></thead>
    <tbody id="usersBody"></tbody>
  </table>
</div>

<script>
const BACKEND_URL = "https://ai-compare-backend-x063.onrender.com";

function getSecret() {
  return document.getElementById("adminSecret").value.trim();
}

document.getElementById("activateBtn").onclick = async () => {
  await callAdmin("/api/admin/activate");
};
document.getElementById("deactivateBtn").onclick = async () => {
  await callAdmin("/api/admin/deactivate");
};

async function callAdmin(endpoint) {
  const msg = document.getElementById("msg");
  const email = document.getElementById("targetEmail").value.trim();
  const secret = getSecret();
  if (!secret) { msg.textContent = "دخل كلمة السر"; return; }
  if (!email) { msg.textContent = "دخل الإيميل"; return; }

  msg.textContent = "كيخدم...";
  try {
    const res = await fetch(BACKEND_URL + endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-secret": secret },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    msg.textContent = res.ok ? data.message : ("خطأ: " + data.error);
  } catch (err) {
    msg.textContent = "خطأ فـ الاتصال: " + err.message;
  }
}

document.getElementById("loadUsersBtn").onclick = async () => {
  const msg = document.getElementById("msg");
  const secret = getSecret();
  if (!secret) { msg.textContent = "دخل كلمة السر"; return; }

  msg.textContent = "كيحمل...";
  try {
    const res = await fetch(BACKEND_URL + "/api/admin/users", {
      headers: { "x-admin-secret": secret }
    });
    const data = await res.json();
    if (!res.ok) { msg.textContent = "خطأ: " + data.error; return; }

    msg.textContent = "";
    const tbody = document.getElementById("usersBody");
    tbody.innerHTML = "";
    data.users.forEach(u => {
      const tr = document.createElement("tr");

      const tdEmail = document.createElement("td");
      tdEmail.textContent = u.email; // textContent بدل innerHTML: ما كيدير parse لأي HTML/script

      const tdStatus = document.createElement("td");
      tdStatus.className = u.is_premium ? "premium-yes" : "premium-no";
      tdStatus.textContent = u.is_premium ? "مشترك" : "مجاني";

      const tdDate = document.createElement("td");
      tdDate.textContent = u.created_at;

      tr.append(tdEmail, tdStatus, tdDate);
      tbody.appendChild(tr);
    });
    document.getElementById("usersTable").style.display = "table";
  } catch (err) {
    msg.textContent = "خطأ فـ الاتصال: " + err.message;
  }
};
</script>
</body>
</html>
