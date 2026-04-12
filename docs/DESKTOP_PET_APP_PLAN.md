# 桌宠应用开发方案

## 一、项目概述

### 1. 项目目标
开发一个桌面应用，用户通过下载安装后，实现与桌宠的对话与交互，并通过用户管理系统进行权限控制。

### 2. 核心功能
- **桌宠交互**：支持多种宠物类型，实现拖拽、状态切换、随机对话等功能
- **用户管理**：注册、登录、权限控制
- **桌面应用**：跨平台支持（Windows、macOS、Linux）
- **后端服务**：API接口、数据存储、用户认证

## 二、技术架构

### 1. 前端技术
- **桌面应用框架**：Electron
- **前端框架**：React 18 + TypeScript
- **状态管理**：Zustand
- **动画效果**：Framer Motion
- **拖拽功能**：React Draggable
- **样式方案**：Tailwind CSS

### 2. 后端技术
- **API框架**：FastAPI
- **数据库**：SQLite（开发环境）/ PostgreSQL（生产环境）
- **认证方案**：JWT
- **邮件服务**：SMTP（腾讯企业邮箱）

### 3. 部署方案
- **桌面应用打包**：Electron-builder
- **后端部署**：Docker + Nginx
- **CI/CD**：GitHub Actions

## 三、系统架构设计

### 1. 整体架构
```
┌─────────────────────┐    ┌─────────────────────┐    ┌─────────────────────┐
│                     │    │                     │    │                     │
│  桌面应用 (Electron) │◄───►│   后端 API (FastAPI) │◄───►│   数据库 (SQLite/PG) │
│                     │    │                     │    │                     │
└─────────────────────┘    └─────────────────────┘    └─────────────────────┘
```

### 2. 核心模块

#### 前端模块
- **桌面应用层**：Electron主进程，负责应用生命周期管理
- **渲染层**：React应用，负责UI渲染和用户交互
- **桌宠核心**：宠物状态管理、动画效果、交互逻辑
- **用户界面**：登录/注册、设置、宠物选择

#### 后端模块
- **认证服务**：用户注册、登录、验证码发送
- **用户管理**：用户信息管理、权限控制
- **桌宠服务**：宠物状态同步、对话管理、数据统计
- **API接口**：RESTful API，支持前端调用

## 四、功能详细设计

### 1. 桌面应用功能

#### 1.1 应用基础功能
- **应用安装**：支持Windows、macOS、Linux平台
- **自动更新**：应用版本检测和自动更新
- **系统托盘**：最小化到系统托盘，支持右键菜单
- **开机自启**：可配置的开机自启动选项

#### 1.2 桌宠功能
- **宠物类型**：支持猪、狗、猫三种宠物类型
- **状态系统**： idle、happy、sad、excited四种状态
- **交互方式**：
  - 点击：随机切换状态和对话
  - 拖拽：拖动宠物到任意位置
  - 自动切换：每2分钟自动切换状态
- **对话系统**：根据宠物类型和状态显示不同的对话内容
- **视觉效果**：平滑的状态切换动画，响应式交互反馈

#### 1.3 用户界面
- **登录/注册**：支持邮箱注册和登录
- **宠物选择**：首次使用时选择宠物类型
- **设置界面**：
  - 宠物行为设置（活跃度、互动频率）
  - 外观设置（大小、透明度）
  - 通知设置（提醒、声音）
  - 账户设置（个人信息、密码修改）

### 2. 后端功能

#### 2.1 用户管理系统
- **用户注册**：邮箱验证码注册
- **用户登录**：用户名/密码登录，JWT token认证
- **权限控制**：
  - 普通用户：基本桌宠功能
  - 高级用户：更多宠物类型、自定义对话
  - 管理员：用户管理、系统设置
- **用户数据**：
  - 个人信息：用户名、邮箱、注册时间
  - 宠物设置：宠物类型、外观偏好、行为设置
  - 互动数据：互动频率、喜欢的对话类型

#### 2.2 桌宠服务
- **宠物状态同步**：将用户的宠物状态存储到云端
- **对话管理**：
  - 系统预设对话
  - 用户自定义对话
  - 智能对话生成（可选）
- **数据统计**：
  - 用户互动数据
  - 宠物状态分布
  - 系统使用情况

#### 2.3 API接口
- **认证接口**：注册、登录、获取当前用户信息
- **用户接口**：更新用户信息、修改密码
- **宠物接口**：获取宠物类型、保存宠物设置、同步宠物状态
- **对话接口**：获取对话内容、添加自定义对话

## 五、数据库设计

### 1. 现有表结构
- **users**：用户信息
- **chat_sessions**：聊天会话
- **chat_messages**：聊天消息
- **documents**：文档上传

### 2. 新增表结构

#### 2.1 pet_settings
```sql
CREATE TABLE pet_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    pet_type VARCHAR(20) NOT NULL,
    appearance_settings JSON,
    behavior_settings JSON,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

#### 2.2 pet_states
```sql
CREATE TABLE pet_states (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    current_state VARCHAR(20) NOT NULL,
    position_x INTEGER DEFAULT 100,
    position_y INTEGER DEFAULT 100,
    last_interaction DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

#### 2.3 pet_messages
```sql
CREATE TABLE pet_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pet_type VARCHAR(20) NOT NULL,
    state VARCHAR(20) NOT NULL,
    content TEXT NOT NULL,
    is_custom BOOLEAN DEFAULT FALSE,
    user_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
```

#### 2.4 user_roles
```sql
CREATE TABLE user_roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    role VARCHAR(20) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

## 六、开发计划

### 1. 阶段一：基础架构搭建（2周）
- **前端**：
  - 初始化Electron + React项目
  - 配置开发环境和构建流程
  - 实现基础桌面应用功能
- **后端**：
  - 扩展现有FastAPI项目
  - 新增桌宠相关数据库表
  - 实现基础API接口

### 2. 阶段二：核心功能开发（3周）
- **前端**：
  - 实现桌宠核心功能（拖拽、状态切换、对话）
  - 开发用户登录/注册界面
  - 实现宠物选择和设置界面
- **后端**：
  - 实现用户管理系统
  - 开发桌宠服务API
  - 实现权限控制功能

### 3. 阶段三：功能完善（2周）
- **前端**：
  - 优化动画效果和用户体验
  - 实现应用设置和系统托盘
  - 开发自动更新功能
- **后端**：
  - 完善API接口文档
  - 实现数据统计功能
  - 优化数据库查询性能

### 4. 阶段四：测试和部署（2周）
- **前端**：
  - 跨平台测试（Windows、macOS、Linux）
  - 性能测试和优化
  - 应用打包和分发
- **后端**：
  - API测试和性能优化
  - 部署到生产环境
  - 配置监控和日志

## 七、技术实现细节

### 1. 桌面应用实现
- **Electron主进程**：
  - 应用生命周期管理
  - 系统托盘集成
  - 自动更新实现
- **渲染进程**：
  - React应用渲染
  - 桌宠组件实现
  - 用户界面开发

### 2. 桌宠核心实现
- **状态管理**：使用Zustand管理宠物状态
- **动画效果**：使用Framer Motion实现平滑动画
- **拖拽功能**：使用React Draggable实现拖拽
- **对话系统**：基于状态和宠物类型的对话管理

### 3. 后端API实现
- **认证系统**：JWT token认证
- **权限控制**：基于角色的权限管理
- **数据同步**：宠物状态的云端同步
- **对话管理**：预设和自定义对话的管理

### 4. 部署方案
- **桌面应用**：
  - Windows：NSIS安装包
  - macOS：DMG格式
  - Linux：AppImage格式
- **后端服务**：
  - Docker容器化
  - Nginx反向代理
  - HTTPS配置

## 八、风险评估

### 1. 技术风险
- **Electron性能**：桌宠应用需要轻量化，避免性能问题
- **跨平台兼容性**：不同操作系统的行为差异
- **后端扩展性**：用户增长时的系统扩展性

### 2. 解决方案
- **性能优化**：
  - 合理使用Electron的渲染进程
  - 优化动画效果，避免过度渲染
  - 使用Web Workers处理复杂计算
- **兼容性处理**：
  - 使用Electron的API抽象层
  - 针对不同平台进行测试和适配
  - 提供平台特定的功能实现
- **扩展性设计**：
  - 采用微服务架构
  - 使用缓存减少数据库压力
  - 实现水平扩展能力

## 九、预期成果

### 1. 桌面应用
- 跨平台支持的桌宠应用
- 流畅的用户界面和交互体验
- 完善的用户管理和权限控制

### 2. 后端服务
- 稳定的API服务
- 安全的用户认证和权限管理
- 可靠的数据存储和同步

### 3. 开发文档
- 详细的技术文档
- API接口文档
- 部署和维护指南

## 十、总结

本方案设计了一个完整的桌宠应用系统，包括桌面应用、后端服务和数据库设计。通过Electron实现跨平台桌面应用，通过FastAPI构建后端服务，实现了用户管理、权限控制和桌宠交互等核心功能。

该方案考虑了技术可行性、性能优化和用户体验，为开发团队提供了清晰的开发路径和实施计划。通过分阶段开发，可以确保系统的稳定性和可靠性，最终交付一个高质量的桌宠应用产品。