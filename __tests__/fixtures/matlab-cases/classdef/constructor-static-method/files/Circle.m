classdef Circle
    properties
        R
    end
    methods
        function obj = Circle(r)
            obj.R = r;
        end
        function a = area(obj)
            a = pi * obj.R^2;
        end
    end
    methods (Static)
        function c = unit()
            c = Circle(1);
        end
    end
end
