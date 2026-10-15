package cn.bigmiao.alfaproxi;

import android.os.Bundle;
import android.view.View;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Android 15+ 强制全面屏（edge-to-edge）：WebView 会顶进状态栏/刘海区。
        // 把系统栏与显示挖孔区转成内容区内边距让出来（iOS 侧由 CSS env(safe-area-inset-*) 处理，
        // 安卓 WebView 的 env() 一直报 0，只能在原生侧做）。
        View content = findViewById(android.R.id.content);
        // 与 web 端 --bg 一致：让出的内边距区域不能露窗口白底
        content.setBackgroundColor(0xFF0F1419);
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, insets) -> {
            Insets bars = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
        });
    }
}
