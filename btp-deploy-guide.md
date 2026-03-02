# Hướng dẫn Clone và Deploy lên SAP BTP

Dưới đây là quy trình chi tiết để bạn có thể tải mã nguồn từ máy công ty và thực hiện build, deploy thẳng lên SAP BTP (Cloud Foundry).

### Chuẩn bị Môi trường (Máy công ty)
Đảm bảo máy công ty bạn đã cài đặt sẵn các CLI sau:
1. **Node.js**: `node -v` (Bản LTS)
2. **Git**: `git --version`
3. **Cloud Foundry CLI**: `cf -v`
4. **MBT (Cloud MTA Build Tool)**: `mbt -v`. Nếu chưa có: `npm install -g mbt`

---

### Bước 1: Clone mã nguồn và cài đặt dependencies

Mở Terminal / Command Prompt và chạy:

```bash
# 1. Clone ứng dụng
git clone https://github.com/dachienit/cap-app-init.git
cd cap-app-init

# 2. Cài đặt các gói NPM thư mục gốc (CAP Backend + Approuter)
npm install

# 3. Cài đặt các gói NPM cho thư mục React
cd app/react-ui
npm install

# Quay lại thư mục gốc
cd ../../
```

---

### Bước 2: Đăng nhập vào SAP BTP (Cloud Foundry)

Sử dụng `cf cli` để login vào môi trường BTP subaccount công ty của bạn:

```bash
# Trỏ đến API Endpoint của vùng BTP (thay link api.cf... bằng API BTP của vùng tương ứng của Subaccount công ty bạn)
# Ví dụ: us10, eu10, ap21...
cf api https://api.cf.us10.hana.ondemand.com 

# Đăng nhập bằng tài khoản SAP (Hoặc dùng SSO tuỳ hệ thống cty)
cf login

# Nếu được hỏi, hãy chọn Org và Space mà bạn muốn deploy project.
```

---

### Bước 3: Build MTA Archive (.mtar)

Sử dụng công cụ `mbt` để đóng gói toàn bộ Frontend (React), Backend (CAP) và Approuter thành một file `.mtar` duy nhất.

```bash
# Chạy ở thư mục gốc (nơi chứa file mta.yaml)
mbt build

# Quá trình này sẽ:
# 1. Cd vào folder react-ui và chạy npm run build (tạo folder dist)
# 2. Build CDS Model cho backend (trong srv/gen)
# 3. Đóng gói ra file my_cap_1_1.0.0.mtar nằm trong thư mục mta_archives/
```

---

### Bước 4: Deploy lên BTP Cloud Foundry

Sau khi build thành công file `.mtar`, tiến hành deploy:

```bash
# Lệnh deploy file mtar vào bộ nhớ Cloud Foundry Space
cf deploy mta_archives/my_cap_1_1.0.0.mtar
```

Quá trình deploy sẽ tự động thực hiện:
- Tạo service instance Authentication XSUAA có tên là `my_cap_1-auth`.
- Triển khai approuter (Single Entry) `my_cap_1`.
- Triển khai CAP server backend `my_cap_1-srv`.
- Liên kết (bind) XSUAA service vào approuter và srv.

---

### Bước 5: Lấy URL và Truy cập 

Sau khi quá trình `cf deploy` hoàn tất, màn hình console sẽ in ra đường dẫn (URL hoặc route) của approuter.

Nếu không rành, bạn có thể kiểm tra lại Route bằng lệnh:
```bash
cf apps
```
Hãy tìm app có tên mở rộng cấu trúc `...-approuter` hoặc `my_cap_1` để lấy URL. Mở URL đó trên trình duyệt. Trình duyệt sẽ yêu cầu bạn đăng nhập qua tài khoản SAP BTP. Sau khi thành công, bạn sẽ thấy React UI và thông tin cá nhân của bạn trên hệ thống công ty!
